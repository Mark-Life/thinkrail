export type {
	AssistantMessage,
	AssistantMessageEvent,
	Message,
	Model,
	StopReason,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";

import type { StopReason } from "@earendil-works/pi-ai";
import {
	NON_EXECUTABLE_STOP_REASONS,
	type SessionState,
	TRANSCRIPT_MESSAGE_ROLES,
	type TranscriptMessageRole,
	type WireModel,
} from "./schema";

const TRANSCRIPT_ROLES: ReadonlySet<string> = new Set(TRANSCRIPT_MESSAGE_ROLES);
const NON_EXECUTABLE: ReadonlySet<StopReason> = new Set(NON_EXECUTABLE_STOP_REASONS);

export function assistantToolCallsAreExecutable(stopReason: StopReason | undefined): boolean {
	return stopReason === undefined || !NON_EXECUTABLE.has(stopReason);
}

/** `WireModel` identity is `{provider, id}`; every other field is a catalog snapshot that may lag. */
export function sameModel(
	a: Pick<WireModel, "provider" | "id"> | null | undefined,
	b: Pick<WireModel, "provider" | "id"> | null | undefined,
): boolean {
	return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

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

export interface ToolResponseDetails {
	toolCallId: string;
	response: unknown;
}

export function isTranscriptMessageRole(role: string): role is TranscriptMessageRole {
	return TRANSCRIPT_ROLES.has(role);
}
