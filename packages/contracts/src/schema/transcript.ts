import type {
	ImageContent as PiImageContent,
	StopReason as PiStopReasonType,
	TextContent as PiTextContent,
	ThinkingContent as PiThinkingContent,
	Usage as PiUsage,
	UserMessage as PiUserMessage,
} from "@earendil-works/pi-ai";
import {
	arr,
	bool,
	lit,
	map,
	num,
	oneOf,
	opt,
	type Schema,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/pi-schema";
import { wireObj } from "./wire";

export const PiStopReason: Schema<PiStopReasonType> = oneOf([
	"pending",
	"stop",
	"length",
	"toolUse",
	"error",
	"aborted",
	"deferred",
]);

export const ImageContent: Schema<PiImageContent> = wireObj({
	type: lit("image"),
	data: str(),
	mimeType: str(),
});
export type ImageContent = Static<typeof ImageContent>;

const TextContent: Schema<PiTextContent> = wireObj({
	type: lit("text"),
	text: str(),
	textSignature: opt(str()),
});

const ThinkingContent: Schema<PiThinkingContent> = wireObj({
	type: lit("thinking"),
	thinking: str(),
	thinkingSignature: opt(str()),
	redacted: opt(bool()),
});

const ToolCall = wireObj({
	type: lit("toolCall"),
	id: str(),
	name: str(),
	arguments: map(unknown()),
	thoughtSignature: opt(str()),
	namespace: opt(str()),
	argumentsError: opt(str()),
});

const Usage: Schema<PiUsage> = wireObj({
	input: num(),
	output: num(),
	cacheRead: num(),
	cacheWrite: num(),
	cacheWrite1h: opt(num()),
	reasoning: opt(num()),
	totalTokens: num(),
	cost: wireObj({
		input: num(),
		output: num(),
		cacheRead: num(),
		cacheWrite: num(),
		total: num(),
		totalFromProvider: opt(bool()),
	}),
});

const UserContent = union([str(), arr(union([TextContent, ImageContent]))]);

const WireUserMessage: Schema<PiUserMessage> = wireObj({
	role: lit("user"),
	content: UserContent,
	timestamp: num(),
});

const WireSystemMessage = wireObj({
	role: lit("system"),
	content: union([str(), arr(TextContent)]),
	timestamp: num(),
});

const WireAssistantMessage = wireObj({
	role: lit("assistant"),
	content: arr(union([TextContent, ThinkingContent, ToolCall])),
	api: str(),
	provider: str(),
	model: str(),
	responseModel: opt(str()),
	responseId: opt(str()),
	usage: Usage,
	stopReason: PiStopReason,
	errorMessage: opt(str()),
	rawStopReason: opt(str()),
	endTurn: opt(bool()),
	timestamp: num(),
	durationMs: opt(num()),
});
export type WireAssistantMessage = Static<typeof WireAssistantMessage>;

const WireToolResultMessage = wireObj({
	role: lit("toolResult"),
	toolCallId: str(),
	toolName: str(),
	content: arr(union([TextContent, ImageContent])),
	details: opt(unknown()),
	usage: opt(Usage),
	isError: bool(),
	timestamp: num(),
	durationMs: opt(num()),
});
export type WireToolResultMessage = Static<typeof WireToolResultMessage>;

export const WireCustomMessage = wireObj({
	role: lit("custom"),
	customType: str(),
	content: UserContent,
	display: bool(),
	details: opt(unknown()),
	timestamp: num(),
});
export type WireCustomMessage<T = unknown> = Omit<Static<typeof WireCustomMessage>, "details"> & {
	details?: T;
};

export const WireCompactionSummary = wireObj({
	role: lit("compactionSummary"),
	summary: str(),
	tokensBefore: num(),
	timestamp: num(),
});
export type WireCompactionSummary = Static<typeof WireCompactionSummary>;

export const TranscriptMessage = union([
	WireUserMessage,
	WireAssistantMessage,
	WireToolResultMessage,
	WireSystemMessage,
	WireCustomMessage,
	WireCompactionSummary,
]);
export type TranscriptMessage = Static<typeof TranscriptMessage>;
