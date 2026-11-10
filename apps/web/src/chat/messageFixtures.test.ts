import type {
	AssistantMessage,
	Usage,
	UserMessage,
	WireCustomMessage,
	WireToolResultMessage,
} from "@thinkrail/contracts";

export const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function assistantMessage(fields: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
		...fields,
	};
}

export function userMessage(content: UserMessage["content"], timestamp = 0): UserMessage {
	return { role: "user", content, timestamp };
}

export function toolResultMessage(
	fields: Pick<WireToolResultMessage, "toolCallId"> & Partial<WireToolResultMessage>,
): WireToolResultMessage {
	return {
		role: "toolResult",
		toolName: "bash",
		content: [],
		isError: false,
		timestamp: 0,
		...fields,
	};
}

export function customMessage<T>(
	fields: Pick<WireCustomMessage<T>, "customType"> & Partial<WireCustomMessage<T>>,
): WireCustomMessage<T> {
	return { role: "custom", content: "", display: true, timestamp: 0, ...fields };
}
