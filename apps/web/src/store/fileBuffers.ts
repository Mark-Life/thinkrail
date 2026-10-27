export type FileBufferStatus =
	| "clean"
	| "dirty"
	| "saving"
	| "stale"
	| "deleted"
	| "readonly"
	| "error";

export type FileBufferError = "tooLarge" | "notEditable" | "offline" | "failed";

export interface FileBufferSummary {
	status: FileBufferStatus;
	dirty: boolean;
	error?: FileBufferError;
}

export type FileBufferSummaries = Record<string, Record<string, FileBufferSummary>>;

function sameSummary(left: FileBufferSummary | undefined, right: FileBufferSummary): boolean {
	return (
		left !== undefined &&
		left.status === right.status &&
		left.dirty === right.dirty &&
		left.error === right.error
	);
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
