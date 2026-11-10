import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { oneOf, type Schema, type Static } from "@earendil-works/pi-schema";
import { StoredSessionId } from "./ids";
import type { ThinkingLevel } from "./model";
import type { AgentSettlement, SessionQueueState } from "./session";
import type { WireAgentMessage } from "./transcript";
import type { Same } from "./typeTie";
import { wireObj } from "./wire";

type ToolExecutionType = "tool_execution_start" | "tool_execution_update" | "tool_execution_end";

/** The tool event fields pi types as `any`: they cross as `unknown`, so a reader must check them. */
type ToolPayloadField = "args" | "partialResult" | "result";

/**
 * Types pi's messages in an event as `WireAgentMessage`, which names the same union in a Node and a browser
 * build, and a tool event's payload fields as `unknown`.
 */
export type WithWireMessages<E> = {
	[K in keyof E]: K extends "message"
		? WireAgentMessage
		: K extends "messages"
			? WireAgentMessage[]
			: E extends { type: ToolExecutionType }
				? K extends ToolPayloadField
					? unknown
					: E[K]
				: E[K];
};

type WithParentToolCallId<E> = E extends { type: ToolExecutionType }
	? E & { parentToolCallId?: string }
	: E;

type CompactionReason = "manual" | "threshold" | "overflow";

/** The events pi-coding-agent adds to pi-agent-core's, which contracts may not import; the host ties them. */
type PiSessionEvent =
	| WithParentToolCallId<Exclude<AgentEvent, { type: "agent_end" }>>
	| { type: "agent_end"; messages: WireAgentMessage[]; willRetry: boolean }
	| { type: "compaction_start"; reason: CompactionReason }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| { type: "summarization_retry_attempt_start"; source: "compaction"; reason: CompactionReason }
	| { type: "summarization_retry_finished" }
	| { type: "bash_execution_update"; id?: string; delta: string };

/** The part of pi's `CompactionResult` the compaction notice renders. */
export interface CompactionEndResult {
	tokensBefore: number;
	estimatedTokensAfter?: number;
}

/** pi-coding-agent's `SessionEntry["type"]`; the host ties the two. */
export type SessionEntryType =
	| "message"
	| "thinking_level_change"
	| "model_change"
	| "usage"
	| "compaction"
	| "branch_summary"
	| "custom"
	| "custom_message"
	| "context_edit"
	| "label"
	| "session_info";

/** The events the host rebuilds from pi's: a settlement, a queue with images, an entry type and a smaller result. */
type PiProjectedEvent =
	| { type: "agent_settled"; terminal: AgentSettlement | null }
	| ({ type: "queue_update" } & SessionQueueState)
	| { type: "entry_appended"; entryType: SessionEntryType }
	| {
			type: "compaction_end";
			reason: CompactionReason;
			result: CompactionEndResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  };

export type PiProjectedEventType = PiProjectedEvent["type"];

/** The pi events the host forwards as pi typed them. */
export type PiForwardedEvent = WithWireMessages<
	Exclude<PiSessionEvent, { type: PiProjectedEventType }>
>;

export type PiEvent = PiForwardedEvent | PiProjectedEvent;

export const PI_EVENT_TYPES = [
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"agent_settled",
	"queue_update",
	"compaction_start",
	"compaction_end",
	"entry_appended",
	"session_info_changed",
	"thinking_level_changed",
	"auto_retry_start",
	"auto_retry_end",
	"summarization_retry_scheduled",
	"summarization_retry_attempt_start",
	"summarization_retry_finished",
	"bash_execution_update",
] as const;
export type PiEventType = Same<(typeof PI_EVENT_TYPES)[number], PiEvent["type"]>;

const PiEventEnvelope = wireObj({
	sessionId: StoredSessionId,
	event: wireObj({ type: oneOf(PI_EVENT_TYPES) }),
});

export interface SessionEventPayload extends Omit<Static<typeof PiEventEnvelope>, "event"> {
	event: PiEvent;
}

/**
 * The trust point for pi's events. pi ships their types and no schemas, so the wire checks `sessionId` and
 * `event.type` against `PI_EVENT_TYPES`, and the event body is pi's type as the host projected it.
 */
export const SessionEventPayload: Schema<SessionEventPayload> = { allOf: [PiEventEnvelope] };
