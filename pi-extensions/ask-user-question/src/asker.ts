import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AskOutcome, AskUserQuestionArgs } from "./core.ts";

export interface AskRequest {
	toolCallId: string;
	args: AskUserQuestionArgs;
	signal: AbortSignal | undefined;
	ctx: ExtensionContext;
}

export type AskUserQuestionAsker = (request: AskRequest) => Promise<AskOutcome>;
