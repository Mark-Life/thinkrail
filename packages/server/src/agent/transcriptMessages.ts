import {
	isTranscriptMessageRole,
	type TranscriptMessage,
	type TranscriptMessageRole,
} from "@thinkrail/contracts";
import type { AgentMessage } from "./piTypes";

const isTranscriptMessage = (
	message: AgentMessage,
): message is Extract<AgentMessage, { role: TranscriptMessageRole }> =>
	isTranscriptMessageRole(message.role);

export function transcriptMessages(messages: readonly AgentMessage[]): TranscriptMessage[] {
	return messages.filter(isTranscriptMessage);
}
