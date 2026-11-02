import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	arr,
	compile,
	lit,
	map,
	num,
	obj,
	oneOf,
	opt,
	type Static,
	str,
	unknown,
} from "@earendil-works/pi-schema";
import { WORKSPACE_TODOS_DIR } from "@thinkrail/shared/paths";
import { assertOverwriteAllowed, parseEntryRecord, readStateFile } from "../persistence";

const REVIEWS_SUFFIX = ".reviews.json";

const TodoReviewRecordSchema = obj(
	{
		state: oneOf(["reviewed", "changes_requested"]),
		reviewedShas: arr(str()),
		feedback: opt(str()),
		at: str(),
		reviewedBy: opt(lit("agent")),
		requestId: opt(str()),
	},
	{ open: true },
);
export type TodoReviewRecord = Static<typeof TodoReviewRecordSchema>;

const PendingReviewSchema = obj({ at: str(), shas: opt(arr(str())) }, { open: true });
type PendingReview = Static<typeof PendingReviewSchema>;

const TodoReviewEntry = compile(TodoReviewRecordSchema);
const PendingEntry = compile(PendingReviewSchema);
const AutoCycleEntry = compile(num());
const StoredReviews = compile(
	obj(
		{
			items: opt(map(unknown())),
			pending: opt(map(unknown())),
			autoCycles: opt(map(unknown())),
		},
		{ open: true },
	),
);

export interface TodoReviewMeta {
	pending: Record<string, PendingReview>;
}

interface ReviewsFile {
	version: 1;
	items: Record<string, TodoReviewRecord>;
	pending?: Record<string, PendingReview>;
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

function readFile(root: string, sessionId: string): ReviewsFile {
	const stored = readStateFile(reviewsPath(root, sessionId));
	if (stored.value === undefined) return { version: 1, items: {} };
	if (!StoredReviews.check(stored.value)) {
		stored.setAside("not a reviews file");
		return { version: 1, items: {} };
	}
	const file: ReviewsFile = {
		version: 1,
		items: parseEntryRecord(stored, stored.value.items ?? {}, TodoReviewEntry),
	};
	const pending = parseEntryRecord(stored, stored.value.pending ?? {}, PendingEntry);
	if (Object.keys(pending).length > 0) file.pending = pending;
	const autoCycles = parseEntryRecord(stored, stored.value.autoCycles ?? {}, AutoCycleEntry);
	if (Object.keys(autoCycles).length > 0) file.autoCycles = autoCycles;
	return file;
}

function writeFile(root: string, sessionId: string, file: ReviewsFile): void {
	const path = reviewsPath(root, sessionId);
	assertOverwriteAllowed(path);
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

export function clearAutoCycles(root: string, sessionId: string, id: string): void {
	const file = readFile(root, sessionId);
	if (!file.autoCycles?.[id]) return;
	delete file.autoCycles[id];
	writeFile(root, sessionId, file);
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
