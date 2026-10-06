import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "@thinkrail/shared/guards";
import { WORKSPACE_TODOS_DIR } from "@thinkrail/shared/paths";

const REVIEWS_SUFFIX = ".reviews.json";

export interface TodoReviewRecord {
	state: "reviewed" | "changes_requested";
	reviewedShas: string[];
	feedback?: string;
	at: string;
	reviewedBy?: "agent";
	requestId?: string;
}

export interface TodoReviewMeta {
	pending: Record<string, { at: string; shas?: string[] }>;
}

interface ReviewsFile {
	version: 1;
	items: Record<string, TodoReviewRecord>;
	pending?: Record<string, { at: string; shas?: string[] }>;
	// Auto fix→re-review cycles spent per item, kept OUTSIDE `items` on purpose: a redo that can't be
	// committed (shared window / foreign dirt) drops the item's `items` entry entirely so the item reads
	// `unreviewed` again (no sha to watermark a path-list delta against — see `todos/artifacts.ts`), but
	// the auto-cycle cap must survive that reset, else the dropped record silently regrants a spent cycle.
	autoCycles?: Record<string, number>;
}

// The session id was validated as a safe path segment by `TodoStore` before any record exists.
function reviewsPath(root: string, sessionId: string): string {
	return join(root, WORKSPACE_TODOS_DIR, `${sessionId}${REVIEWS_SUFFIX}`);
}

function isTodoReviewRecord(raw: unknown): raw is TodoReviewRecord {
	if (!isRecord(raw)) return false;
	return (
		(raw.state === "reviewed" || raw.state === "changes_requested") &&
		Array.isArray(raw.reviewedShas) &&
		raw.reviewedShas.every((s) => typeof s === "string") &&
		(raw.feedback === undefined || typeof raw.feedback === "string") &&
		(raw.reviewedBy === undefined || raw.reviewedBy === "agent") &&
		(raw.requestId === undefined || typeof raw.requestId === "string") &&
		typeof raw.at === "string"
	);
}

function parseAutoCycles(raw: unknown): Record<string, number> | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const autoCycles = Object.fromEntries(
		Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
	);
	return Object.keys(autoCycles).length > 0 ? autoCycles : undefined;
}

function readFile(root: string, sessionId: string): ReviewsFile {
	try {
		const parsed: unknown = JSON.parse(readFileSync(reviewsPath(root, sessionId), "utf8"));
		if (!isRecord(parsed)) return { version: 1, items: {} };
		const items: Record<string, TodoReviewRecord> = {};
		if (typeof parsed.items === "object" && parsed.items !== null) {
			for (const [id, value] of Object.entries(parsed.items)) {
				if (isTodoReviewRecord(value)) items[id] = value;
			}
		}
		const file: ReviewsFile = { version: 1, items };
		if (typeof parsed.pending === "object" && parsed.pending !== null) {
			const pending: ReviewsFile["pending"] = {};
			for (const [id, value] of Object.entries(parsed.pending)) {
				if (!isRecord(value)) continue;
				const { at, shas: rawShas } = value;
				if (typeof at !== "string") continue;
				const shas =
					Array.isArray(rawShas) && rawShas.every((s): s is string => typeof s === "string")
						? rawShas
						: undefined;
				pending[id] = { at, ...(shas ? { shas } : {}) };
			}
			if (Object.keys(pending).length > 0) file.pending = pending;
		}
		const autoCycles = parseAutoCycles(parsed.autoCycles);
		if (autoCycles) file.autoCycles = autoCycles;
		return file;
	} catch {
		return { version: 1, items: {} };
	}
}

function writeFile(root: string, sessionId: string, file: ReviewsFile): void {
	const path = reviewsPath(root, sessionId);
	const empty =
		Object.keys(file.items).length === 0 &&
		Object.keys(file.pending ?? {}).length === 0 &&
		Object.keys(file.autoCycles ?? {}).length === 0;
	if (empty) {
		rmSync(path, { force: true });
		return;
	}
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
	renameSync(tmp, path);
}

export function readReviewMeta(root: string, sessionId: string): TodoReviewMeta {
	return { pending: readFile(root, sessionId).pending ?? {} };
}

export function markReviewPending(
	root: string,
	sessionId: string,
	id: string,
	shas?: string[],
): void {
	const file = readFile(root, sessionId);
	file.pending = {
		...(file.pending ?? {}),
		[id]: { at: new Date().toISOString(), ...(shas ? { shas } : {}) },
	};
	writeFile(root, sessionId, file);
}

export function clearReviewPending(root: string, sessionId: string, id: string): void {
	const file = readFile(root, sessionId);
	if (!file.pending?.[id]) return;
	delete file.pending[id];
	writeFile(root, sessionId, file);
}

export function readAutoCycles(root: string, sessionId: string, id: string): number | undefined {
	return readFile(root, sessionId).autoCycles?.[id];
}

export function setAutoCycles(root: string, sessionId: string, id: string, value: number): void {
	const file = readFile(root, sessionId);
	file.autoCycles = { ...(file.autoCycles ?? {}), [id]: value };
	writeFile(root, sessionId, file);
}

export function clearAutoCycles(root: string, sessionId: string, id: string): void {
	const file = readFile(root, sessionId);
	if (!file.autoCycles?.[id]) return;
	delete file.autoCycles[id];
	writeFile(root, sessionId, file);
}

export function readReviewRecords(
	root: string,
	sessionId: string,
): Record<string, TodoReviewRecord> {
	return readFile(root, sessionId).items;
}

export function putReviewRecord(
	root: string,
	sessionId: string,
	id: string,
	record: TodoReviewRecord,
): TodoReviewRecord | undefined {
	const file = readFile(root, sessionId);
	const previous = file.items[id];
	file.items[id] = record;
	writeFile(root, sessionId, file);
	return previous;
}

/** Apply a review-verdict transition — the item's record, its auto-cycle count, and its pending-mark
 * clear — as ONE snapshot write, so a partial failure can never leave the sidecar inconsistent (e.g.
 * `changes_requested` at a spent cycle with the pending mark still set, which strands the automatic
 * flow). `autoCycles` is a number to set or `"clear"` to drop. See host/planReview.SPEC.md. */
export function commitReviewTransition(
	root: string,
	sessionId: string,
	id: string,
	opts: { record: TodoReviewRecord; autoCycles: number | "clear"; clearPending?: boolean },
): void {
	const file = readFile(root, sessionId);
	file.items[id] = opts.record;
	if (opts.autoCycles === "clear") {
		if (file.autoCycles?.[id] !== undefined) delete file.autoCycles[id];
	} else {
		file.autoCycles = { ...(file.autoCycles ?? {}), [id]: opts.autoCycles };
	}
	if (opts.clearPending && file.pending?.[id]) delete file.pending[id];
	writeFile(root, sessionId, file);
}

export function restoreReviewRecord(
	root: string,
	sessionId: string,
	id: string,
	expected: TodoReviewRecord,
	previous: TodoReviewRecord | undefined,
): boolean {
	const file = readFile(root, sessionId);
	if (file.items[id]?.requestId !== expected.requestId) return false;
	if (previous) file.items[id] = previous;
	else delete file.items[id];
	writeFile(root, sessionId, file);
	return true;
}

export function dropReviewRecord(
	root: string,
	sessionId: string,
	id: string,
	previous?: TodoReviewRecord,
): void {
	const file = readFile(root, sessionId);
	if (previous) file.items[id] = previous;
	else if (file.items[id] === undefined) return;
	else delete file.items[id];
	writeFile(root, sessionId, file);
}

export function removeSessionReviews(root: string, sessionId: string): void {
	try {
		rmSync(reviewsPath(root, sessionId), { force: true });
	} catch {}
}

/** Host-restart reconciliation — see host/SPEC.md ("reconcilePendingReviewsOnBoot"). */
export function clearAllPendingReviews(root: string): { sessionId: string; itemIds: string[] }[] {
	let names: string[];
	try {
		names = readdirSync(join(root, WORKSPACE_TODOS_DIR)).filter((n) => n.endsWith(REVIEWS_SUFFIX));
	} catch {
		return [];
	}
	const cleared: { sessionId: string; itemIds: string[] }[] = [];
	for (const name of names) {
		const sessionId = name.slice(0, -REVIEWS_SUFFIX.length);
		const file = readFile(root, sessionId);
		const itemIds = Object.keys(file.pending ?? {});
		if (itemIds.length === 0) continue;
		file.pending = {};
		writeFile(root, sessionId, file);
		cleared.push({ sessionId, itemIds });
	}
	return cleared;
}
