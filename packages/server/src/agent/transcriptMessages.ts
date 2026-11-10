import {
	type AgentMessage,
	isTranscriptMessageRole,
	type TranscriptMessage,
} from "@thinkrail/contracts";

function transcriptMessageOf(message: AgentMessage): TranscriptMessage[] {
	switch (message.role) {
		case "user":
		case "assistant":
		case "toolResult":
		case "custom":
		case "compactionSummary":
			return [message];
		default:
			return [];
	}
}

export function transcriptMessages(messages: readonly AgentMessage[]): TranscriptMessage[] {
	return messages.flatMap((message) =>
		isTranscriptMessageRole(message.role) ? transcriptMessageOf(message) : [],
	);
}
