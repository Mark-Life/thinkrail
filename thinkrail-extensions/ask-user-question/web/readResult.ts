import {
	type AskUserQuestionResult,
	isAskUserQuestionResult,
} from "@thinkrail/pi-ask-user-question/core";

export function readAskUserQuestionResult(raw: unknown): AskUserQuestionResult | null {
	const details =
		typeof raw === "object" && raw !== null && "details" in raw ? raw.details : undefined;
	if (isAskUserQuestionResult(details)) return details;
	return isAskUserQuestionResult(raw) ? raw : null;
}
