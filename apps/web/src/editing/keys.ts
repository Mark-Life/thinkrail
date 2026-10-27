import { LFS_POINTER_MIME, type ResourceMeta } from "@thinkrail/contracts";
import { tupleKey } from "../lib";

export const AUTOSAVE_DELAY_MS = 1000;

export function fileBufferKey(workspaceId: string, path: string): string {
	return tupleKey("file-buffer", workspaceId, path);
}

export function isEditableMeta(meta: Pick<ResourceMeta, "text" | "mime">): boolean {
	return meta.text && meta.mime !== LFS_POINTER_MIME;
}
