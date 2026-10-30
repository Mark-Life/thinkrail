import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
	ATTRIBUTION_MAX_POLLS,
	ATTRIBUTION_ORIGIN,
	ATTRIBUTION_POLL_INTERVAL_MS,
	claimIdPattern,
	parseRedeemedAttribution,
	type RedeemedAttribution,
} from "../persistence";

const closed = { additionalProperties: false };
const ClaimCreatedSchema = Type.Object(
	{
		claim_id: Type.String(),
		claim_url: Type.String(),
		expires_at: Type.Integer({
			minimum: Number.MIN_SAFE_INTEGER,
			maximum: Number.MAX_SAFE_INTEGER,
		}),
	},
	closed,
);
const ClaimPendingSchema = Type.Object({ error: Type.Literal("pending") }, closed);
const ClaimBoundSchema = Type.Object({ status: Type.Literal("bound") }, closed);

export const ATTRIBUTION_REQUEST_TIMEOUT_MS = 5_000;
export const ATTRIBUTION_DEADLINE_MS = 9 * 60 * 1_000;

export interface AttributionClaimDependencies {
	endpoint?: string;
	fetchImpl?: typeof fetch;
	openExternal(url: string): void | Promise<void>;
	sleep?(milliseconds: number): Promise<void>;
	signal?: AbortSignal;
	requestTimeoutMs?: number;
	overallDeadlineMs?: number;
	pollIntervalMs?: number;
	maxPolls?: number;
	active(): boolean;
	persist(record: RedeemedAttribution): void;
	linked(record: RedeemedAttribution): void;
}

function base64Url(value: Uint8Array): string {
	return Buffer.from(value).toString("base64url");
}

function verifierAndChallenge(): { verifier: string; challenge: string } {
	const verifier = base64Url(randomBytes(32));
	const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
	return { verifier, challenge };
}

function abortError(): Error {
	return new DOMException("The operation was aborted", "AbortError");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

async function strictJson(response: Response, signal: AbortSignal): Promise<unknown | undefined> {
	const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
	if (response.body === null) return undefined;
	if (contentType !== "application/json") {
		await response.body.cancel();
		return undefined;
	}
	const declaredLength = response.headers.get("content-length");
	if (declaredLength !== null) {
		const parsedLength = Number(declaredLength);
		if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > 16_384) {
			await response.body.cancel();
			return undefined;
		}
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await abortable(reader.read(), signal);
			if (done) break;
			total += value.byteLength;
			if (total > 16_384) {
				await reader.cancel();
				return undefined;
			}
			chunks.push(value);
		}
		const body = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
		const parsed: unknown = JSON.parse(text);
		return parsed;
	} catch {
		return undefined;
	} finally {
		reader.releaseLock();
	}
}

async function postJson(
	url: string,
	body: { challenge: string } | { verifier: string },
	fetchImpl: typeof fetch,
	parentSignal: AbortSignal,
	timeoutMs: number,
): Promise<{ response: Response; value: unknown | undefined }> {
	const request = new AbortController();
	const abortRequest = () => request.abort();
	parentSignal.addEventListener("abort", abortRequest, { once: true });
	const timeout = setTimeout(abortRequest, timeoutMs);
	try {
		const response = await abortable(
			Promise.resolve().then(() =>
				fetchImpl(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
					redirect: "error",
					signal: request.signal,
				}),
			),
			request.signal,
		);
		const value = await strictJson(response, request.signal);
		return { response, value };
	} finally {
		clearTimeout(timeout);
		parentSignal.removeEventListener("abort", abortRequest);
		request.abort();
	}
}

function claimUrl(endpoint: URL, claimId: string, value: string): string | undefined {
	if (value !== `/attribution/claim/?id=${claimId}`) return undefined;
	const resolved = new URL(value, endpoint);
	return resolved.origin === endpoint.origin ? resolved.href : undefined;
}

export async function runAttributionClaim(
	dependencies: AttributionClaimDependencies,
): Promise<void> {
	const fetchImpl = dependencies.fetchImpl ?? fetch;
	const requestTimeoutMs = dependencies.requestTimeoutMs ?? ATTRIBUTION_REQUEST_TIMEOUT_MS;
	const overallDeadlineMs = dependencies.overallDeadlineMs ?? ATTRIBUTION_DEADLINE_MS;
	const pollIntervalMs = dependencies.pollIntervalMs ?? ATTRIBUTION_POLL_INTERVAL_MS;
	const maxPolls = dependencies.maxPolls ?? ATTRIBUTION_MAX_POLLS;
	let endpoint: URL;
	try {
		endpoint = new URL(dependencies.endpoint ?? ATTRIBUTION_ORIGIN);
		if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash) return;
	} catch {
		return;
	}

	const overall = new AbortController();
	const abortOverall = () => overall.abort();
	dependencies.signal?.addEventListener("abort", abortOverall, { once: true });
	const deadline = setTimeout(abortOverall, overallDeadlineMs);
	const { verifier, challenge } = verifierAndChallenge();
	try {
		if (dependencies.signal?.aborted) return;
		const createdResult = await postJson(
			new URL("/api/attribution/claims", endpoint).href,
			{ challenge },
			fetchImpl,
			overall.signal,
			requestTimeoutMs,
		);
		const { response: createdResponse, value: created } = createdResult;
		if (
			!dependencies.active() ||
			createdResponse.status !== 201 ||
			!Check(ClaimCreatedSchema, created)
		)
			return;
		const now = Date.now();
		if (
			!claimIdPattern.test(created.claim_id) ||
			created.expires_at <= now ||
			created.expires_at > now + 11 * 60 * 1_000
		) {
			return;
		}
		const externalUrl = claimUrl(endpoint, created.claim_id, created.claim_url);
		if (!externalUrl) return;
		try {
			const opening = dependencies.openExternal(externalUrl);
			void Promise.resolve(opening).catch(() => {});
		} catch {
			return;
		}
		if (!dependencies.active()) return;

		const verifiedBody = { verifier };
		for (let poll = 0; poll < maxPolls; poll++) {
			if (dependencies.sleep) {
				await abortable(dependencies.sleep(pollIntervalMs), overall.signal);
			} else {
				await delay(pollIntervalMs, undefined, { signal: overall.signal });
			}
			if (!dependencies.active()) return;
			const statusResult = await postJson(
				new URL(`/api/attribution/claims/${created.claim_id}/status`, endpoint).href,
				verifiedBody,
				fetchImpl,
				overall.signal,
				requestTimeoutMs,
			);
			const { response: statusResponse, value: status } = statusResult;
			if (!dependencies.active()) return;
			if (statusResponse.status === 409 && Check(ClaimPendingSchema, status)) continue;
			if (statusResponse.status !== 200 || !Check(ClaimBoundSchema, status)) return;

			const redeemResult = await postJson(
				new URL(`/api/attribution/claims/${created.claim_id}/redeem`, endpoint).href,
				verifiedBody,
				fetchImpl,
				overall.signal,
				requestTimeoutMs,
			);
			const { response: redeemResponse, value: redeemedValue } = redeemResult;
			if (!dependencies.active() || redeemResponse.status !== 200) return;
			const redeemed = parseRedeemedAttribution(redeemedValue, Date.now());
			if (!redeemed) return;
			try {
				dependencies.persist(redeemed);
			} catch {}
			if (!dependencies.active()) return;
			dependencies.linked(redeemed);
			return;
		}
	} catch {
	} finally {
		clearTimeout(deadline);
		dependencies.signal?.removeEventListener("abort", abortOverall);
		overall.abort();
	}
}
