import { arr, bool, lit, num, opt, type Static, str } from "@earendil-works/pi-schema";
import {
	DELEGATION_RUN_FIELDS,
	RUN_LIFECYCLE_STATUSES,
	RunLifecycleStatus,
} from "pi-delegation/wire";
import { SUBAGENT_COMPLETION_FIELDS } from "pi-subagents/wire";
import { SessionId, StoredSessionId, WorkspaceId } from "./ids";
import { TranscriptMessage } from "./transcript";
import { Ack, wireObj } from "./wire";

export { CompletionDelivery } from "pi-background-commands/wire";

export const DELEGATION_RUN_STATUSES = RUN_LIFECYCLE_STATUSES;
export const DelegationRunStatus = RunLifecycleStatus;
export type DelegationRunStatus = Static<typeof DelegationRunStatus>;

/** A delegated run as `pi-delegation` reports it in a tool result's `details`. */
export const DelegationRunDetails = wireObj(DELEGATION_RUN_FIELDS);
export type DelegationRunDetails = Static<typeof DelegationRunDetails>;

export const SubagentCompletionDetails = wireObj(SUBAGENT_COMPLETION_FIELDS);
export type SubagentCompletionDetails = Static<typeof SubagentCompletionDetails>;

const { roleName, task, status, model, thinkingLevel, abortReason, durationMs } =
	DELEGATION_RUN_FIELDS;

export const SubagentResourceSummary = wireObj({
	childSessionId: StoredSessionId,
	parentSessionId: StoredSessionId,
	roleName,
	task,
	status,
	createdAt: str(),
	detached: opt(bool()),
	model,
	thinkingLevel,
	abortReason,
	durationMs: opt(durationMs),
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
