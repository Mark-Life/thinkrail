import {
	arr,
	bool,
	int,
	oneOf,
	opt,
	type Schema,
	type Static,
	type StaticObject,
	str,
} from "@earendil-works/pi-schema";
import { WorkspaceId } from "./ids";
import { ResourceMeta } from "./resourceMeta";
import type { Same } from "./typeTie";
import { selfRef, wireObj, withId } from "./wire";

export const FileKind = oneOf(["file", "dir"]);
export type FileKind = Static<typeof FileKind>;

const FILE_NODE_FIELDS = { path: str(), name: str(), kind: FileKind, gitignored: opt(bool()) };

export interface FileNode extends StaticObject<typeof FILE_NODE_FIELDS> {
	children?: FileNode[];
}

const Node = withId(
	wireObj({ ...FILE_NODE_FIELDS, children: opt(arr(selfRef<FileNode>())) }),
	"FileNode",
);
export const FileNode: Schema<Same<Static<typeof Node>, FileNode>> = Node;

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
