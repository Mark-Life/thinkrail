import type {
	AssistantMessage,
	Message,
	ImageContent as PiImageContent,
	StopReason as PiStopReasonType,
	TextContent as PiTextContent,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import {
	arr,
	lit,
	oneOf,
	opt,
	type Schema,
	type Static,
	str,
	union,
} from "@earendil-works/pi-schema";
import type { Same } from "./typeTie";
import { wireObj } from "./wire";

export const PiStopReason = oneOf([
	"pending",
	"stop",
	"length",
	"toolUse",
	"error",
	"aborted",
	"deferred",
]);
export type PiStopReason = Same<Static<typeof PiStopReason>, PiStopReasonType>;

export const ImageContent = wireObj({ type: lit("image"), data: str(), mimeType: str() });
export type ImageContent = Same<Static<typeof ImageContent>, PiImageContent>;

const TextContent = wireObj({ type: lit("text"), text: str(), textSignature: opt(str()) });

/** A custom message's content: the text and image blocks a user message holds. */
export const CustomMessageContent = union([str(), arr(union([TextContent, ImageContent]))]);
export type CustomMessageContent = Same<
	Static<typeof CustomMessageContent>,
	UserMessage["content"]
>;

/** pi-coding-agent's `CustomMessage`, which contracts may not import; the host ties the two. */
export interface WireCustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (PiTextContent | PiImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

/** pi-coding-agent's `CompactionSummaryMessage`; the host ties the two. */
export interface WireCompactionSummary {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

/** pi-coding-agent's `BranchSummaryMessage`; the host ties the two. */
export interface WireBranchSummary {
	role: "branchSummary";
	summary: string;
	fromId: string | null;
	timestamp: number;
}

/** pi-coding-agent's `BashExecutionMessage`; the host ties the two. */
export interface WireBashExecution {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	excludeFromContext?: boolean;
}

/** Every message a pi event may carry: pi's `AgentMessage` as the host compiles it. */
export type WireAgentMessage =
	| Message
	| WireCustomMessage
	| WireCompactionSummary
	| WireBranchSummary
	| WireBashExecution;

/** The messages `session.getMessages` returns, in pi's own types. */
export type TranscriptMessage =
	| UserMessage
	| AssistantMessage
	| ToolResultMessage
	| WireCustomMessage
	| WireCompactionSummary;

export const TRANSCRIPT_MESSAGE_ROLES = [
	"user",
	"assistant",
	"toolResult",
	"custom",
	"compactionSummary",
] as const;
export type TranscriptMessageRole = Same<
	(typeof TRANSCRIPT_MESSAGE_ROLES)[number],
	TranscriptMessage["role"]
>;

/**
 * The trust point for pi's messages. pi ships their types and no schemas, so the wire checks `role` against
 * `TRANSCRIPT_MESSAGE_ROLES`, and the body is pi's type as the host received it from pi.
 */
export const TranscriptMessage: Schema<TranscriptMessage> = {
	allOf: [wireObj({ role: oneOf(TRANSCRIPT_MESSAGE_ROLES) })],
};
