import {
	CLIENT_ERROR_REPORT_PROTOCOL_VERSION,
	type ClientErrorKind,
	type ClientErrorReport,
	JsonObject,
	WS_METHODS,
	type WsMethodName,
} from "@thinkrail/contracts";
import { useAppStore } from "../store";
import { type DroppedFrame, droppedFrameCode } from "./transport";
import { getTransport } from "./wireTransport";

declare global {
	var _posthogChunkIds: unknown;
}

const MAX_REPORTS_PER_PAGE = 50;
const MAX_PENDING = 10;

let sent = 0;
let pending: ClientErrorReport[] = [];
let unsubscribe: (() => void) | null = null;

export function supportsClientErrorReports(protocolVersion: number | null): boolean {
	return protocolVersion !== null && protocolVersion >= CLIENT_ERROR_REPORT_PROTOCOL_VERSION;
}

const MAX_CHUNK_IDS = 20;
const STACK_URL = /((?:https?|views):\/\/[^\s()@]+):\d+:\d+(?=[)\s]|$)/gm;

function stackUrls(stack: string): string[] {
	return Array.from(stack.matchAll(STACK_URL)).flatMap((match) => match[1] ?? []);
}

export function chunkIdsForStack(
	stack: string,
	registry: unknown = globalThis._posthogChunkIds,
): Record<string, string> | undefined {
	if (!JsonObject.check(registry)) return undefined;
	const wanted = new Set(stackUrls(stack));
	const out: Record<string, string> = {};
	let count = 0;
	for (const [key, id] of Object.entries(registry)) {
		if (typeof id !== "string" || count >= MAX_CHUNK_IDS) continue;
		const url = stackUrls(key).at(-1);
		if (url && wanted.has(url) && !(url in out)) {
			out[url] = id;
			count++;
		}
	}
	return count ? out : undefined;
}

function messageFreeStack(error: Error): string {
	const stack = typeof error.stack === "string" ? error.stack : "";
	const at = error.message ? stack.indexOf(error.message) : -1;
	return at < 0 ? stack : `${stack.slice(0, at)}${stack.slice(at + error.message.length)}`;
}

export function clientErrorReport(
	kind: ClientErrorKind,
	error: unknown,
	boundary?: string,
): ClientErrorReport {
	const real = error instanceof Error ? error : null;
	const stack = real ? messageFreeStack(real) : "";
	const chunkIds = stack ? chunkIdsForStack(stack) : undefined;
	return {
		kind,
		type:
			(typeof real?.name === "string" && real.name) ||
			(kind === "rejection" ? "UnhandledRejection" : "Error"),
		...(stack ? { stack } : {}),
		...(boundary ? { boundary } : {}),
		...(chunkIds ? { chunkIds } : {}),
	};
}

export function reportInvalidReply(method: WsMethodName): void {
	if (method === WS_METHODS.clientReportError) return;
	reportClientError({
		kind: "rejection",
		type: "RequestError",
		boundary: `INVALID_REPLY:${method}`,
	});
}

const reportedFrames = new Set<string>();

export function reportDroppedFrame(frame: DroppedFrame): void {
	const boundary = droppedFrameCode(frame);
	if (reportedFrames.has(boundary)) return;
	reportedFrames.add(boundary);
	reportClientError({
		kind: "window",
		type: "WireError",
		boundary,
	});
}

function deliver(report: ClientErrorReport, protocolVersion: number): void {
	if (!supportsClientErrorReports(protocolVersion) || sent >= MAX_REPORTS_PER_PAGE) return;
	sent++;
	try {
		getTransport()
			.request("client.reportError", report)
			.catch(() => {});
	} catch {}
}

export function reportClientError(report: ClientErrorReport): void {
	try {
		const version = useAppStore.getState().protocolVersion;
		if (version !== null) {
			deliver(report, version);
			return;
		}
		if (pending.length < MAX_PENDING) pending.push(report);
		unsubscribe ??= useAppStore.subscribe((state) => {
			if (state.protocolVersion === null) return;
			unsubscribe?.();
			unsubscribe = null;
			const queued = pending;
			pending = [];
			for (const item of queued) deliver(item, state.protocolVersion);
		});
	} catch {}
}

export function installClientErrorReporting(target: EventTarget = window): () => void {
	const onError = (event: Event) => {
		const error = "error" in event ? event.error : undefined;
		const message = "message" in event ? event.message : undefined;
		if (error !== undefined || message) {
			reportClientError(clientErrorReport("window", error ?? message));
		}
	};
	const onRejection = (event: Event) => {
		reportClientError(clientErrorReport("rejection", "reason" in event ? event.reason : undefined));
	};
	target.addEventListener("error", onError);
	target.addEventListener("unhandledrejection", onRejection);
	return () => {
		target.removeEventListener("error", onError);
		target.removeEventListener("unhandledrejection", onRejection);
	};
}

export function resetClientErrorReportsForTests(): void {
	sent = 0;
	reportedFrames.clear();
	pending = [];
	unsubscribe?.();
	unsubscribe = null;
}
