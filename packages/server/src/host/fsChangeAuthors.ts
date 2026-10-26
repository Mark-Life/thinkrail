import { isAbsolute, relative, resolve } from "node:path";
import type { FsChangeWrite, WorkspaceFsChangedPayload } from "@thinkrail/contracts";
import { fileProvenance, type Provenance } from "../provenance";
import { getWorkspace } from "../workspaces";

function worktreeRoot(workspaceId: string): string | null {
	try {
		return getWorkspace(workspaceId).worktreePath;
	} catch {
		return null;
	}
}

function insideRoot(root: string, path: string): string | null {
	const abs = resolve(root, path);
	const rel = relative(root, abs);
	return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? null : abs;
}

export function withFsChangeAuthors(
	payload: WorkspaceFsChangedPayload,
	options: {
		provenance?: Pick<Provenance, "changeWrite">;
		root?: (workspaceId: string) => string | null;
	} = {},
): WorkspaceFsChangedPayload {
	if (payload.truncated || payload.paths.length === 0) return payload;
	const root = (options.root ?? worktreeRoot)(payload.workspaceId);
	if (root === null) return payload;
	const provenance = options.provenance ?? fileProvenance;
	const authors: Record<string, FsChangeWrite> = {};
	for (const path of payload.paths) {
		const abs = insideRoot(root, path);
		const write = abs === null ? undefined : provenance.changeWrite(abs);
		if (write) authors[path] = write;
	}
	return Object.keys(authors).length > 0 ? { ...payload, authors } : payload;
}
