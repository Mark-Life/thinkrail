import type { FsChangeWrite, WorkspaceFsChangedPayload } from "@thinkrail/contracts";
import { resolveWorktreeFile } from "../fs";
import { fileProvenance, type Provenance } from "../provenance";

function resolvedPath(workspaceId: string, path: string): string | null {
	try {
		return resolveWorktreeFile(workspaceId, path);
	} catch {
		return null;
	}
}

export function withFsChangeAuthors(
	payload: WorkspaceFsChangedPayload,
	options: {
		provenance?: Pick<Provenance, "changeWrite">;
		resolve?: (workspaceId: string, path: string) => string | null;
	} = {},
): WorkspaceFsChangedPayload {
	if (payload.truncated || payload.paths.length === 0) return payload;
	const provenance = options.provenance ?? fileProvenance;
	const resolve = options.resolve ?? resolvedPath;
	const authors: Record<string, FsChangeWrite> = {};
	for (const path of payload.paths) {
		const abs = resolve(payload.workspaceId, path);
		const write = abs === null ? undefined : provenance.changeWrite(abs);
		if (write) authors[path] = write;
	}
	return Object.keys(authors).length > 0 ? { ...payload, authors } : payload;
}
