import { arr, bool, nullable, num, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import { GitDiffScope } from "./diffScope";
import { ResourceMeta } from "./resourceMeta";
import { wireObj } from "./wire";

export const GitFileStatus = oneOf(["added", "modified", "deleted", "renamed", "untracked"]);
export type GitFileStatus = Static<typeof GitFileStatus>;

export const GitFileChange = wireObj({
	path: str(),
	status: GitFileStatus,
	added: opt(num()),
	removed: opt(num()),
});
export type GitFileChange = Static<typeof GitFileChange>;

export const GitStatus = wireObj({
	branch: str(),
	changes: arr(GitFileChange),
});
export type GitStatus = Static<typeof GitStatus>;

export const GitCommit = wireObj({
	sha: str(),
	shortSha: str(),
	subject: str(),
	author: str(),
	committedAt: str(),
});
export type GitCommit = Static<typeof GitCommit>;

export const RemoteBranchGroup = wireObj({
	remote: nullable(str()),
	branches: arr(wireObj({ ref: str(), branch: str() })),
});
export type RemoteBranchGroup = Static<typeof RemoteBranchGroup>;

export const BranchList = wireObj({
	local: arr(str()),
	remote: arr(str()),
	remoteGroups: opt(arr(RemoteBranchGroup)),
	defaultBranch: str(),
});
export type BranchList = Static<typeof BranchList>;

export const GIT_METHODS = {
	"git.listBranches": { params: wireObj({ projectId: str() }), result: BranchList },
	"git.prefetch": {
		params: wireObj({ projectId: str(), ref: str() }),
		result: wireObj({ ok: bool() }),
	},
	"git.status": {
		params: wireObj({ workspaceId: str(), scope: opt(GitDiffScope) }),
		result: GitStatus,
	},
	"git.diffFile": {
		params: wireObj({ workspaceId: str(), path: str(), scope: opt(GitDiffScope) }),
		result: wireObj({
			original: str(),
			modified: str(),
			originalOid: nullable(str()),
			meta: wireObj({ original: ResourceMeta, modified: ResourceMeta }),
		}),
	},
	"git.listCommits": {
		params: wireObj({ workspaceId: str() }),
		result: wireObj({ commits: arr(GitCommit) }),
	},
};
