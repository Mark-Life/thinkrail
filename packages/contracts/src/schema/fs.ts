import { arr, bool, int, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import { WorkspaceId } from "./ids";
import { ResourceMeta } from "./resourceMeta";
import { wireObj } from "./wire";

export const FileKind = oneOf(["file", "dir"]);
export type FileKind = Static<typeof FileKind>;

export const FileNode = wireObj({
	path: str(),
	name: str(),
	kind: FileKind,
	gitignored: opt(bool()),
});
export type FileNode = Static<typeof FileNode>;

export const FS_METHODS = {
	"fs.readDir": {
		params: wireObj({ workspaceId: WorkspaceId, path: str() }),
		result: arr(FileNode),
	},
	"fs.readFile": {
		params: wireObj({ workspaceId: WorkspaceId, path: str(), maxBytes: opt(int({ minimum: 0 })) }),
		result: wireObj({ content: str(), meta: ResourceMeta }),
	},
};
