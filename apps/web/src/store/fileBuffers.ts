import type { FileSaveMode } from "@thinkrail/contracts";

export type FileBufferStatus =
	| "clean"
	| "dirty"
	| "saving"
	| "stale"
	| "conflict"
	| "deleted"
	| "readonly"
	| "error";

export type FileBufferError = "tooLarge" | "notEditable" | "offline" | "failed";

export interface FileBufferSummary {
	status: FileBufferStatus;
	dirty: boolean;
	error?: FileBufferError;
	conflicts?: number;
	merges?: number;
	pending?: true;
}

export type FileSaveIndicator = "unsaved" | "saving" | "pending";

export type FileBufferSummaries = Record<string, Record<string, FileBufferSummary>>;

function sameSummary(left: FileBufferSummary | undefined, right: FileBufferSummary): boolean {
	return (
		left !== undefined &&
		left.status === right.status &&
		left.dirty === right.dirty &&
		left.error === right.error &&
		left.conflicts === right.conflicts &&
		left.merges === right.merges &&
		left.pending === right.pending
	);
}

export function fileSaveIndicator(
	summary: FileBufferSummary | undefined,
	mode: FileSaveMode,
): FileSaveIndicator | null {
	if (summary?.dirty !== true) return null;
	if (mode === "manual") return summary.status === "saving" ? "saving" : "unsaved";
	const writing =
		summary.status === "saving" || (summary.status === "dirty" && summary.pending === true);
	return writing ? "pending" : "unsaved";
}

export function withFileBufferSummary(
	summaries: FileBufferSummaries,
	workspaceId: string,
	path: string,
	summary: FileBufferSummary | null,
): FileBufferSummaries {
	const current = summaries[workspaceId] ?? {};
	if (summary === null) {
		if (!(path in current)) return summaries;
		const rest = { ...current };
		delete rest[path];
		return { ...summaries, [workspaceId]: rest };
	}
	if (sameSummary(current[path], summary)) return summaries;
	return { ...summaries, [workspaceId]: { ...current, [path]: summary } };
}
