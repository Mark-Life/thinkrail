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
import { ProjectId, SessionId, WorkspaceId } from "./ids";
import { ThinkingLevel, WireModel } from "./model";
import { OpenBranchReview, ReviewProvider } from "./pr";
import { SessionStateRecord } from "./session";
import { ImageContent } from "./transcript";
import { Ack, NoParams, wireObj } from "./wire";

export const DiffStats = wireObj({ added: num(), removed: num() });
export type DiffStats = Static<typeof DiffStats>;

export const SubagentOverride = oneOf(["on", "off"]);
export type SubagentOverride = Static<typeof SubagentOverride>;

/** `"settled"` = the user parked the workspace on the shelf; `"active"` = the user pinned it live. */
export const SettledOverride = oneOf(["settled", "active"]);
export type SettledOverride = Static<typeof SettledOverride>;

export const Workspace = wireObj({
	id: WorkspaceId,
	projectId: ProjectId,
	kind: opt(oneOf(["default", "external"])),
	name: str(),
	branch: str(),
	worktreePath: str(),
	baseBranch: str(),
	diffBase: opt(str()),
	renamed: opt(bool()),
	/** Session id of the chat whose `set_title` named the workspace but kept its branch; only that chat may still move it. */
	branchNamePending: opt(SessionId),
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
	workspaceId: WorkspaceId,
	sessionId: SessionId,
	startedAt: num(),
	settledAt: num(),
	baseTree: str(),
	headTree: str(),
	changes: arr(GitFileChange),
});
export type TurnChangeSet = Static<typeof TurnChangeSet>;

export const WorkspaceWatchReadyResult = wireObj({ startupNudge: bool() });
export type WorkspaceWatchReadyResult = Static<typeof WorkspaceWatchReadyResult>;

export const WorkspaceCreationState = oneOf(["running", "interrupted", "failed"]);
export type WorkspaceCreationState = Static<typeof WorkspaceCreationState>;

export const WorkspaceCreationPhase = oneOf(["preparing", "checking-out"]);
export type WorkspaceCreationPhase = Static<typeof WorkspaceCreationPhase>;

export const WorkspaceKickoff = wireObj({
	text: str(),
	images: opt(arr(ImageContent)),
	model: opt(WireModel),
	thinkingLevel: opt(ThinkingLevel),
});
export type WorkspaceKickoff = Static<typeof WorkspaceKickoff>;

/** The `WorkspaceCreation` properties, so a stored creation record can extend the wire shape. */
export const WorkspaceCreationFields = {
	id: WorkspaceId,
	projectId: ProjectId,
	name: str(),
	branch: str(),
	baseBranch: str(),
	state: WorkspaceCreationState,
	phase: WorkspaceCreationPhase,
	progress: opt(wireObj({ done: num(), total: num() })),
	failure: opt(wireObj({ message: str(), code: opt(str()), cleanedUp: opt(lit(true)) })),
	kickoff: opt(wireObj({ text: str(), imageCount: num() })),
	startedAt: num(),
};
export const WorkspaceCreation = wireObj(WorkspaceCreationFields);
export type WorkspaceCreation = Static<typeof WorkspaceCreation>;

const WorkspaceTarget = wireObj({ id: WorkspaceId });

export const WorkspaceRemoved = wireObj({ projectId: ProjectId, id: WorkspaceId });
export type WorkspaceRemoved = Static<typeof WorkspaceRemoved>;

export const WorkspaceCreationRemoved = wireObj({
	id: WorkspaceId,
	projectId: ProjectId,
	workspace: opt(Workspace),
	sessionId: opt(SessionId),
	kickoffError: opt(str()),
});
export type WorkspaceCreationRemoved = Static<typeof WorkspaceCreationRemoved>;

export const WorkspaceSkillChange = oneOf(["none", "detected", "unknown"]);
export type WorkspaceSkillChange = Static<typeof WorkspaceSkillChange>;

export const WorkspaceFsChangedPayload = wireObj({
	workspaceId: WorkspaceId,
	paths: arr(str()),
	truncated: bool(),
	skillChange: WorkspaceSkillChange,
});
export type WorkspaceFsChangedPayload = Static<typeof WorkspaceFsChangedPayload>;

export const WORKSPACE_METHODS = {
	"workspace.create": {
		params: wireObj({ projectId: ProjectId, name: opt(str()), baseRef: opt(str()) }),
		result: Workspace,
	},
	"workspace.startCreate": {
		params: wireObj({
			projectId: ProjectId,
			name: opt(str()),
			baseRef: opt(str()),
			kickoff: opt(WorkspaceKickoff),
		}),
		result: WorkspaceCreation,
	},
	"workspace.listCreations": { params: NoParams, result: arr(WorkspaceCreation) },
	"workspace.retryCreation": { params: WorkspaceTarget, result: WorkspaceCreation },
	"workspace.dismissCreation": {
		params: WorkspaceTarget,
		result: wireObj({ kickoff: opt(WorkspaceKickoff) }),
	},
	"workspace.rename": { params: wireObj({ id: WorkspaceId, name: str() }), result: Workspace },
	"workspace.listExisting": {
		params: wireObj({ projectId: ProjectId }),
		result: arr(ExistingWorktreeCandidate),
	},
	"workspace.openExisting": {
		params: wireObj({ projectId: ProjectId, path: str() }),
		result: Workspace,
	},
	"workspace.list": {
		params: wireObj({ projectId: ProjectId, includeDiffStats: opt(bool()) }),
		result: arr(Workspace),
	},
	"workspace.openReview": {
		params: wireObj({ workspaceId: WorkspaceId, allowCached: opt(bool()) }),
		result: nullable(OpenBranchReview),
	},
	"workspace.branchStatus": {
		params: wireObj({ workspaceId: WorkspaceId, allowCached: opt(bool()), skipFetch: opt(bool()) }),
		result: BranchStatus,
	},
	"workspace.push": {
		params: wireObj({ workspaceId: WorkspaceId, branch: str(), confirmBase: opt(bool()) }),
		result: wireObj({ dirtyFiles: num() }),
	},
	"workspace.deleteRemoteBranch": {
		params: wireObj({ workspaceId: WorkspaceId, branch: str() }),
		result: Ack,
	},
	"workspace.remove": { params: WorkspaceTarget, result: Ack },
	"workspace.diffStats": { params: WorkspaceTarget, result: DiffStats },
	"workspace.setSkillOverride": {
		params: wireObj({ id: WorkspaceId, name: str(), override: nullable(oneOf(["on", "off"])) }),
		result: Workspace,
	},
	"workspace.setSubagentsOverride": {
		params: wireObj({ id: WorkspaceId, override: nullable(SubagentOverride) }),
		result: Workspace,
	},
	"workspace.setSubagentMaxConcurrent": {
		params: wireObj({ id: WorkspaceId, value: nullable(num()) }),
		result: Workspace,
	},
	"workspace.setDiffBase": {
		params: wireObj({ id: WorkspaceId, ref: nullable(str()) }),
		result: Workspace,
	},
	"workspace.settle": { params: WorkspaceTarget, result: Workspace },
	"workspace.unsettle": { params: WorkspaceTarget, result: Workspace },
	"workspace.markUnread": {
		params: WorkspaceTarget,
		result: wireObj({ record: nullable(SessionStateRecord) }),
	},
	"workspace.markRead": {
		params: WorkspaceTarget,
		result: wireObj({ records: arr(SessionStateRecord) }),
	},
	"workspace.watchReady": {
		params: wireObj({ workspaceId: WorkspaceId, prewarm: opt(bool()) }),
		result: WorkspaceWatchReadyResult,
	},
	"workspace.openIn": { params: wireObj({ id: WorkspaceId, editor: str() }), result: Ack },
	"workspace.reveal": { params: WorkspaceTarget, result: Ack },
	"workspace.turns": {
		params: wireObj({ workspaceId: WorkspaceId }),
		result: wireObj({ turns: arr(TurnChangeSet) }),
	},
};

export const WORKSPACE_CHANNELS = {
	"workspace.created": Workspace,
	"workspace.updated": Workspace,
	"workspace.removed": WorkspaceRemoved,
	"workspace.fsChanged": WorkspaceFsChangedPayload,
	"workspace.creationChanged": WorkspaceCreation,
	"workspace.creationRemoved": WorkspaceCreationRemoved,
	"turn.changed": TurnChangeSet,
};
