import {
	arr,
	bool,
	lit,
	map,
	nullable,
	num,
	oneOf,
	opt,
	type Static,
	str,
	union,
} from "@earendil-works/pi-schema";
import { GitFileChange } from "./git";
import { OpenBranchReview, ReviewProvider } from "./pr";
import { SessionStateRecord } from "./session";
import { Ack, wireObj } from "./wire";

export const DiffStats = wireObj({ added: num(), removed: num() });
export type DiffStats = Static<typeof DiffStats>;

export const SubagentOverride = oneOf(["on", "off"]);
export type SubagentOverride = Static<typeof SubagentOverride>;

/** `"settled"` = the user parked the workspace on the shelf; `"active"` = the user pinned it live. */
export const SettledOverride = oneOf(["settled", "active"]);
export type SettledOverride = Static<typeof SettledOverride>;

export const Workspace = wireObj({
	id: str(),
	projectId: str(),
	kind: opt(oneOf(["default", "external"])),
	name: str(),
	branch: str(),
	worktreePath: str(),
	baseBranch: str(),
	diffBase: opt(str()),
	renamed: opt(bool()),
	initialTerminalPending: opt(lit(true)),
	diffStats: opt(DiffStats),
	skillOverrides: opt(map(oneOf(["on", "off"]))),
	subagentsOverride: opt(SubagentOverride),
	/** Per-chat concurrent-subagent limit for this workspace; absent = the global `subagentMaxConcurrent`. */
	subagentMaxConcurrentOverride: opt(num()),
	/** Newest real activity (chat/agent turn, terminal input, HEAD move) in ms; viewing never counts. */
	lastActiveAt: opt(num()),
	settledOverride: opt(SettledOverride),
	settledAt: opt(num()),
	/** The host's last-known review for the branch; refreshed host-side so every client sees one state. */
	review: opt(OpenBranchReview),
});
export type Workspace = Static<typeof Workspace>;

/** `workspace.branchStatus`: where the branch stands against origin and its base, review or not. */
export const BranchStatus = wireObj({
	hasOrigin: bool(),
	/** The forge `origin` points at; `null` without an origin or for any other host. */
	provider: nullable(ReviewProvider),
	/** The push repository has the branch; `null` when it couldn't be read (split origin, `ls-remote` failed). */
	published: nullable(bool()),
	/** Origin pushes to another URL than it fetches from: ahead/behind describe the push repository. */
	pushesElsewhere: bool(),
	/** Published only: local commits origin lacks. */
	ahead: opt(num()),
	/** Published only: last-known origin commits HEAD lacks (the branch diverged). */
	behind: opt(num()),
	/** Commits on HEAD that the workspace's base lacks. */
	aheadOfBase: num(),
	/** The branch is its own base (Default on the default branch): no PR can be opened from it. */
	onBase: bool(),
	review: nullable(OpenBranchReview),
});
export type BranchStatus = Static<typeof BranchStatus>;

export const ExistingWorktreeCandidate = union([
	wireObj({ path: str(), branch: str(), status: lit("available") }),
	wireObj({ path: str(), status: lit("detached") }),
]);
export type ExistingWorktreeCandidate = Static<typeof ExistingWorktreeCandidate>;

export const TurnChangeSet = wireObj({
	id: str(),
	workspaceId: str(),
	sessionId: str(),
	startedAt: num(),
	settledAt: num(),
	baseTree: str(),
	headTree: str(),
	changes: arr(GitFileChange),
});
export type TurnChangeSet = Static<typeof TurnChangeSet>;

export const WorkspaceWatchReadyResult = wireObj({ startupNudge: bool() });
export type WorkspaceWatchReadyResult = Static<typeof WorkspaceWatchReadyResult>;

const WorkspaceId = wireObj({ id: str() });

export const WORKSPACE_METHODS = {
	"workspace.create": {
		params: wireObj({ projectId: str(), name: opt(str()), baseRef: opt(str()) }),
		result: Workspace,
	},
	"workspace.rename": { params: wireObj({ id: str(), name: str() }), result: Workspace },
	"workspace.listExisting": {
		params: wireObj({ projectId: str() }),
		result: arr(ExistingWorktreeCandidate),
	},
	"workspace.openExisting": {
		params: wireObj({ projectId: str(), path: str() }),
		result: Workspace,
	},
	"workspace.list": {
		params: wireObj({ projectId: str(), includeDiffStats: opt(bool()) }),
		result: arr(Workspace),
	},
	"workspace.openReview": {
		params: wireObj({ workspaceId: str(), allowCached: opt(bool()) }),
		result: nullable(OpenBranchReview),
	},
	"workspace.branchStatus": {
		params: wireObj({ workspaceId: str(), allowCached: opt(bool()), skipFetch: opt(bool()) }),
		result: BranchStatus,
	},
	"workspace.push": {
		params: wireObj({ workspaceId: str(), branch: str(), confirmBase: opt(bool()) }),
		result: wireObj({ dirtyFiles: num() }),
	},
	"workspace.deleteRemoteBranch": {
		params: wireObj({ workspaceId: str(), branch: str() }),
		result: Ack,
	},
	"workspace.remove": { params: WorkspaceId, result: Ack },
	"workspace.diffStats": { params: WorkspaceId, result: DiffStats },
	"workspace.setSkillOverride": {
		params: wireObj({ id: str(), name: str(), override: nullable(oneOf(["on", "off"])) }),
		result: Workspace,
	},
	"workspace.setSubagentsOverride": {
		params: wireObj({ id: str(), override: nullable(SubagentOverride) }),
		result: Workspace,
	},
	"workspace.setSubagentMaxConcurrent": {
		params: wireObj({ id: str(), value: nullable(num()) }),
		result: Workspace,
	},
	"workspace.setDiffBase": {
		params: wireObj({ id: str(), ref: nullable(str()) }),
		result: Workspace,
	},
	"workspace.settle": { params: WorkspaceId, result: Workspace },
	"workspace.unsettle": { params: WorkspaceId, result: Workspace },
	"workspace.markUnread": {
		params: WorkspaceId,
		result: wireObj({ record: nullable(SessionStateRecord) }),
	},
	"workspace.markRead": {
		params: WorkspaceId,
		result: wireObj({ records: arr(SessionStateRecord) }),
	},
	"workspace.watchReady": {
		params: wireObj({ workspaceId: str(), prewarm: opt(bool()) }),
		result: WorkspaceWatchReadyResult,
	},
	"workspace.openIn": { params: wireObj({ id: str(), editor: str() }), result: Ack },
	"workspace.reveal": { params: WorkspaceId, result: Ack },
	"workspace.turns": {
		params: wireObj({ workspaceId: str() }),
		result: wireObj({ turns: arr(TurnChangeSet) }),
	},
};
