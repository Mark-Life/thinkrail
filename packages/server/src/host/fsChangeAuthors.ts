import { isAbsolute, relative, resolve, sep } from "node:path";
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
	const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
	return rel === "" || escapes ? null : abs;
}

export function withFsChangeAuthors(
	payload: WorkspaceFsChangedPayload,
	options: {
		provenance?: Pick<Provenance, "changeWrite">;
		root?: (workspaceId: string) => string | null;
		republish?: (payload: WorkspaceFsChangedPayload) => void;
	} = {},
): WorkspaceFsChangedPayload {
	if (payload.truncated || payload.paths.length === 0) return payload;
	const root = (options.root ?? worktreeRoot)(payload.workspaceId);
	if (root === null) return payload;
	const provenance = options.provenance ?? fileProvenance;
	const { republish } = options;
	const authors: Record<string, FsChangeWrite> = {};
	for (const path of payload.paths) {
		const abs = insideRoot(root, path);
		const late =
			republish &&
			((write: FsChangeWrite) =>
				republish({
					workspaceId: payload.workspaceId,
					paths: [path],
					truncated: false,
					skillChange: "none",
					authorsOnly: true,
					authors: { [path]: write },
				}));
		const write = abs === null ? undefined : provenance.changeWrite(abs, late);
		if (write) authors[path] = write;
	}
	return Object.keys(authors).length > 0 ? { ...payload, authors } : payload;
}
