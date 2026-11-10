import { arr, bool, lit, num, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import { SessionId, StoredSessionId, WorkspaceId } from "./ids";
import { ThinkingLevel } from "./model";
import { TranscriptMessage } from "./transcript";
import { Ack, wireObj } from "./wire";

export const DELEGATION_RUN_STATUSES = [
	"queued",
	"running",
	"completed",
	"error",
	"aborted",
] as const;
export const DelegationRunStatus = oneOf(DELEGATION_RUN_STATUSES);
export type DelegationRunStatus = Static<typeof DelegationRunStatus>;

const DELEGATION_RUN_FIELDS = {
	childSessionId: str(),
	roleName: opt(str()),
	roleSource: opt(str()),
	task: str(),
	status: DelegationRunStatus,
	model: opt(str()),
	thinkingLevel: opt(ThinkingLevel),
	usage: wireObj({
		input: num(),
		output: num(),
		cacheRead: num(),
		cacheWrite: num(),
		cost: num(),
		turns: num(),
		contextTokens: num(),
	}),
	durationMs: num(),
	activity: opt(str()),
	abortReason: opt(str()),
};

/** A delegated run as `pi-delegation` reports it in a tool result's `details`. */
export const DelegationRunDetails = wireObj(DELEGATION_RUN_FIELDS);
export type DelegationRunDetails = Static<typeof DelegationRunDetails>;

export const CompletionDelivery = oneOf(["wake", "run", "appended"]);
export type CompletionDelivery = Static<typeof CompletionDelivery>;

export const SubagentCompletionDetails = wireObj({
	...DELEGATION_RUN_FIELDS,
	delivery: opt(CompletionDelivery),
});
export type SubagentCompletionDetails = Static<typeof SubagentCompletionDetails>;

export const SubagentResourceSummary = wireObj({
	childSessionId: StoredSessionId,
	parentSessionId: StoredSessionId,
	roleName: opt(str()),
	task: str(),
	status: DelegationRunStatus,
	createdAt: str(),
	detached: opt(bool()),
	model: opt(str()),
	thinkingLevel: opt(ThinkingLevel),
	abortReason: opt(str()),
	durationMs: opt(num()),
	finishedAt: opt(num()),
	/** The host or the chat's teardown ended this run; `status` is then terminal (see `interruptedResource`). */
	interrupted: opt(lit(true)),
});
export type SubagentResourceSummary = Static<typeof SubagentResourceSummary>;

const ChildTarget = wireObj({
	workspaceId: WorkspaceId,
	parentSessionId: SessionId,
	childSessionId: SessionId,
});

export const SUBAGENT_METHODS = {
	"subagent.stop": { params: ChildTarget, result: Ack },
	"subagent.stopAll": {
		params: wireObj({ workspaceId: WorkspaceId, parentSessionId: SessionId }),
		result: wireObj({ ok: lit(true), targeted: num() }),
	},
	"subagent.getTranscript": {
		params: ChildTarget,
		result: wireObj({ messages: arr(TranscriptMessage), status: opt(DelegationRunStatus) }),
	},
};
