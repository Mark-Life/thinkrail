import {
	arr,
	bool,
	int,
	lit,
	nullable,
	num,
	oneOf,
	opt,
	type Static,
	str,
	tuple,
	union,
	unknown,
} from "@earendil-works/pi-schema";
import { ExtUiDialogRequest, ExtUiResponse } from "./extUi";
import { SessionId, StoredProjectId, StoredSessionId, StoredWorkspaceId, WorkspaceId } from "./ids";
import { ThinkingLevel, WireModel } from "./model";
import {
	ResourceHistoryCursor,
	ResourceHistoryPage,
	ResourceKind,
	SessionResources,
} from "./resource";
import { SlashCommandInfo } from "./skill";
import { ImageContent, PiStopReason, TranscriptMessage } from "./transcript";
import { Ack, NoParams, readonlyArr, wireObj } from "./wire";

export const AgentSettlement = wireObj({ stopReason: PiStopReason, errorMessage: opt(str()) });
export type AgentSettlement = Static<typeof AgentSettlement>;

export const SessionInputState = union([
	wireObj({ interactionId: str(), kind: lit("tool-response"), toolCallId: str() }),
	wireObj({ interactionId: str(), kind: lit("dialog"), request: ExtUiDialogRequest }),
]);
export type SessionInputState = Static<typeof SessionInputState>;

export const SessionCompletion = union([
	wireObj({ completionId: str(), outcome: oneOf(["succeeded", "interrupted", "cancelled"]) }),
	wireObj({ completionId: str(), outcome: lit("failed"), failure: oneOf(["error", "length"]) }),
]);
export type SessionCompletion = Static<typeof SessionCompletion>;

export const SessionState = wireObj({
	execution: oneOf(["idle", "running"]),
	runId: nullable(str()),
	needsInput: nullable(SessionInputState),
	completion: nullable(SessionCompletion),
	completionUnread: bool(),
	queuedCount: num(),
	backgroundWork: bool(),
});
export type SessionState = Static<typeof SessionState>;

export const SessionStateRecord = wireObj({
	sessionId: StoredSessionId,
	workspaceId: StoredWorkspaceId,
	projectId: StoredProjectId,
	state: SessionState,
	title: opt(str()),
	firstPrompt: opt(str()),
});
export type SessionStateRecord = Static<typeof SessionStateRecord>;

export const ContextUsage = wireObj({
	tokens: nullable(num()),
	contextWindow: num(),
	percent: nullable(num()),
});
export type ContextUsage = Static<typeof ContextUsage>;

export const SessionStats = wireObj({
	sessionId: StoredSessionId,
	totalMessages: num(),
	tokens: wireObj({
		input: num(),
		output: num(),
		cacheRead: num(),
		cacheWrite: num(),
		total: num(),
	}),
	cost: num(),
	contextUsage: opt(ContextUsage),
});
export type SessionStats = Static<typeof SessionStats>;

export const QueueLane = oneOf(["steering", "followUp"]);
export type QueueLane = Static<typeof QueueLane>;

export const SessionQueueState = wireObj({
	steering: readonlyArr(str()),
	followUp: readonlyArr(str()),
	hasImages: opt(lit(true)),
});
export type SessionQueueState = Static<typeof SessionQueueState>;

export const QueuedMessageContent = wireObj({
	text: str(),
	images: opt(readonlyArr(ImageContent)),
});
export type QueuedMessageContent = Static<typeof QueuedMessageContent>;

export const SessionQueueContent = wireObj({
	steering: readonlyArr(QueuedMessageContent),
	followUp: readonlyArr(QueuedMessageContent),
});
export type SessionQueueContent = Static<typeof SessionQueueContent>;

export const RemovedQueuedMessage = wireObj({
	removed: nullable(QueuedMessageContent),
	queue: SessionQueueState,
});
export type RemovedQueuedMessage = Static<typeof RemovedQueuedMessage>;

export const SessionSummary = wireObj({
	sessionId: StoredSessionId,
	workspaceId: StoredWorkspaceId,
	title: str(),
	firstPrompt: opt(str()),
	model: nullable(WireModel),
	thinkingLevel: ThinkingLevel,
	isStreaming: bool(),
	messageCount: num(),
	updatedAt: num(),
	live: bool(),
	openTodos: opt(num()),
	lastSettlement: opt(nullable(AgentSettlement)),
	queue: opt(SessionQueueState),
	state: opt(SessionState),
});
export type SessionSummary = Static<typeof SessionSummary>;

const SessionTarget = wireObj({ sessionId: SessionId });
const ScopedSession = wireObj({ workspaceId: WorkspaceId, sessionId: SessionId });

export const SessionDeletedPayload = wireObj({
	workspaceId: StoredWorkspaceId,
	sessionId: StoredSessionId,
});
export type SessionDeletedPayload = Static<typeof SessionDeletedPayload>;
const UserMessageParams = wireObj({
	sessionId: SessionId,
	text: str(),
	images: opt(arr(ImageContent)),
});

export const SESSION_METHODS = {
	"session.create": {
		params: wireObj({
			workspaceId: WorkspaceId,
			model: opt(WireModel),
			thinkingLevel: opt(ThinkingLevel),
		}),
		result: wireObj({
			sessionId: StoredSessionId,
			model: nullable(WireModel),
			thinkingLevel: ThinkingLevel,
		}),
	},
	"session.prompt": { params: UserMessageParams, result: Ack },
	"session.steer": { params: UserMessageParams, result: Ack },
	"session.followUp": { params: UserMessageParams, result: Ack },
	"session.clearQueue": {
		params: wireObj({ sessionId: SessionId, requireTextOnly: opt(bool()) }),
		result: SessionQueueContent,
	},
	"session.removeQueued": {
		params: wireObj({ sessionId: SessionId, kind: QueueLane, index: num() }),
		result: RemovedQueuedMessage,
	},
	"session.abort": {
		params: wireObj({ sessionId: SessionId, restoreQueue: opt(bool()) }),
		result: wireObj({ ok: lit(true), restoredQueue: opt(SessionQueueContent) }),
	},
	"session.dispose": { params: SessionTarget, result: Ack },
	"session.delete": { params: ScopedSession, result: Ack },
	"session.rename": {
		params: wireObj({ workspaceId: WorkspaceId, sessionId: SessionId, title: str() }),
		result: Ack,
	},
	"session.setModel": { params: wireObj({ sessionId: SessionId, model: WireModel }), result: Ack },
	"session.setThinkingLevel": {
		params: wireObj({ sessionId: SessionId, level: ThinkingLevel }),
		result: Ack,
	},
	"session.compact": {
		params: wireObj({ sessionId: SessionId, instructions: opt(str()) }),
		result: Ack,
	},
	"session.getStats": { params: SessionTarget, result: SessionStats },
	"session.getCommands": { params: SessionTarget, result: arr(SlashCommandInfo) },
	"session.reloadResources": { params: SessionTarget, result: Ack },
	"session.extUiReply": { params: wireObj({ response: ExtUiResponse }), result: Ack },
	"session.respondToTool": {
		params: wireObj({ sessionId: SessionId, toolCallId: str(), response: unknown() }),
		result: Ack,
	},
	"session.answerQuestion": {
		params: wireObj({ sessionId: SessionId, toolCallId: str(), result: unknown() }),
		result: Ack,
	},
	"session.list": { params: wireObj({ workspaceId: WorkspaceId }), result: arr(SessionSummary) },
	"session.stateList": { params: NoParams, result: arr(SessionStateRecord) },
	"session.acknowledgeCompletion": {
		params: wireObj({ sessionId: SessionId, completionId: str() }),
		result: wireObj({ acknowledged: bool(), record: SessionStateRecord }),
	},
	"session.nudge": {
		params: wireObj({
			workspaceId: WorkspaceId,
			sessionId: SessionId,
			text: str(),
			images: opt(arr(ImageContent)),
		}),
		result: wireObj({ disposition: oneOf(["needs_input", "queued", "prompted"]) }),
	},
	"session.activityList": { params: NoParams, result: tuple([]) },
	"session.getMessages": {
		params: ScopedSession,
		result: wireObj({ summary: SessionSummary, messages: arr(TranscriptMessage) }),
	},
	"session.resources": { params: ScopedSession, result: SessionResources },
	"session.resourceHistory": {
		params: wireObj({
			workspaceId: WorkspaceId,
			sessionId: SessionId,
			kind: ResourceKind,
			before: opt(ResourceHistoryCursor),
			limit: opt(int({ minimum: 1 })),
		}),
		result: ResourceHistoryPage,
	},
};

export const SESSION_CHANNELS = {
	"pi.event": wireObj({ sessionId: StoredSessionId, event: wireObj({ type: str() }) }),
	"session.created": SessionSummary,
	"session.deleted": SessionDeletedPayload,
	"session.resourcesChanged": SessionDeletedPayload,
	"session.state": SessionStateRecord,
};
