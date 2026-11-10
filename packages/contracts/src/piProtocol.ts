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

import { type SessionState, TRANSCRIPT_MESSAGE_ROLES, type WireModel } from "./schema";

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
