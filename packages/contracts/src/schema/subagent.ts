import { arr, bool, lit, num, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import { SessionId, WorkspaceId } from "./ids";
import { ThinkingLevel } from "./model";
import { TranscriptMessage } from "./transcript";
import { Ack, wireObj } from "./wire";

export const DelegationRunStatus = oneOf(["queued", "running", "completed", "error", "aborted"]);
export type DelegationRunStatus = Static<typeof DelegationRunStatus>;

export const SubagentResourceSummary = wireObj({
	childSessionId: SessionId,
	parentSessionId: SessionId,
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
