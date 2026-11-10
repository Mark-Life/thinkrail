import {
	arr,
	bool,
	int,
	oneOf,
	opt,
	type Schema,
	type Static,
	str,
} from "@earendil-works/pi-schema";
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

const FileNodeRef: Schema<FileNode> = { $ref: "#" };

export const FileNode: Schema<FileNode> = {
	...wireObj({
		path: str(),
		name: str(),
		kind: FileKind,
		gitignored: opt(bool()),
		children: opt(arr(FileNodeRef)),
	}),
	$id: "FileNode",
};

export const FS_METHODS = {
	"fs.readDir": { params: wireObj({ workspaceId: str(), path: str() }), result: arr(FileNode) },
	"fs.readFile": {
		params: wireObj({ workspaceId: str(), path: str(), maxBytes: opt(int({ minimum: 0 })) }),
		result: wireObj({ content: str(), meta: ResourceMeta }),
	},
};
