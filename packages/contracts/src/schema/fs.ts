import { arr, bool, oneOf, type Schema, type Static, str } from "@earendil-works/pi-schema";
import { WorkspaceId } from "./ids";
import { ResourceMeta } from "./resourceMeta";
import { wireObj } from "./wire";

export const FileKind = oneOf(["file", "dir"]);
export type FileKind = Static<typeof FileKind>;

export interface FileNode {
	path: string;
	name: string;
	kind: FileKind;
	gitignored?: boolean;
	children?: FileNode[];
}

export const FileNode: Schema<FileNode> = {
	$id: "FileNode",
	type: "object",
	required: ["path", "name", "kind"],
	properties: {
		path: str(),
		name: str(),
		kind: FileKind,
		gitignored: bool(),
		children: arr({ $ref: "#" }),
	},
};

export const FS_METHODS = {
	"fs.readDir": {
		params: wireObj({ workspaceId: WorkspaceId, path: str() }),
		result: arr(FileNode),
	},
	"fs.readFile": {
		params: wireObj({ workspaceId: WorkspaceId, path: str() }),
		result: wireObj({ content: str(), meta: ResourceMeta }),
	},
};
