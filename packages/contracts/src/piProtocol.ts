export type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
export type {
	AssistantMessage,
	AssistantMessageEvent,
	Message,
	Model,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";

import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AgentSettlement,
	type SessionId,
	type SessionState,
	type ThinkingLevel,
	TRANSCRIPT_MESSAGE_ROLES,
	type WireAgentMessage,
	type WireModel,
} from "./schema";

const TRANSCRIPT_ROLES: ReadonlySet<string> = new Set(TRANSCRIPT_MESSAGE_ROLES);

const NON_EXECUTABLE_TOOL_CALL_STOP_REASONS: ReadonlySet<string> = new Set([
	"error",
	"aborted",
	"length",
]);

export function assistantToolCallsAreExecutable(stopReason: string | undefined): boolean {
	return stopReason === undefined || !NON_EXECUTABLE_TOOL_CALL_STOP_REASONS.has(stopReason);
}

/** `WireModel` identity is `{provider, id}`; every other field is a catalog snapshot that may lag. */
export function sameModel(
	a: Pick<WireModel, "provider" | "id"> | null | undefined,
	b: Pick<WireModel, "provider" | "id"> | null | undefined,
): boolean {
	return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

export type SessionInputKind = "tool-response" | "dialog";

export function isSessionWorking(state: SessionState): boolean {
	return state.execution === "running" || state.backgroundWork === true;
}

export function canMarkCompletionUnread(state: SessionState): boolean {
	return (
		!isSessionWorking(state) &&
		state.needsInput === null &&
		state.completion !== null &&
		state.completion.outcome !== "cancelled" &&
		!state.completionUnread
	);
}

type WithWireMessage<E> = E extends { message: AgentMessage }
	? Omit<E, "message"> & { message: WireAgentMessage }
	: E;

export type PiEvent =
	| WithWireMessage<Exclude<AgentEvent, { type: "agent_end" }>>
	| { type: "agent_end"; messages: WireAgentMessage[]; willRetry: boolean }
	| { type: "agent_settled"; terminal: AgentSettlement | null }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
			hasImages?: true;
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "entry_appended"; entryType: string }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionEndResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
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
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "bash_execution_update"; id?: string; delta: string };

export interface CompactionEndResult {
	tokensBefore: number;
	estimatedTokensAfter?: number;
}

export interface SessionEventPayload {
	sessionId: SessionId;
	event: PiEvent;
}

export interface ToolResponsePendingDetails {
	kind: "ack";
}

export interface ToolResponseDetails {
	toolCallId: string;
	response: unknown;
}

export function isTranscriptMessageRole(role: string): boolean {
	return TRANSCRIPT_ROLES.has(role);
}
