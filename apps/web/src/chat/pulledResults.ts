import {
	BACKGROUND_COMMAND_TERMINAL_STATUSES,
	type BackgroundCommandCompletionDetails,
	isBackgroundCommandOutputDetails,
	isDelegationRunDetails,
	JsonObject,
	type SubagentCompletionDetails,
	type ToolInputs,
} from "@thinkrail/contracts";
import { parseToolResultContent, strArg } from "@thinkrail/extension-api/web";
import type { ChatTurn, ToolResultState } from "./types";

export type PulledResult =
	| { kind: "subagentCompletion"; key: string; details: SubagentCompletionDetails; text: string }
	| {
			kind: "backgroundCommandCompletion";
			key: string;
			details: BackgroundCommandCompletionDetails;
	  };

const EXCERPT_CHARS = 4096;
const EXCERPT_LINES = 40;

export function resultKey(turn: ChatTurn): string | undefined {
	if (turn.kind === "subagentCompletion") return `subagent:${turn.details.childSessionId}`;
	if (turn.kind === "backgroundCommandCompletion") return `command:${turn.details.id}`;
	return undefined;
}

function excerpt(text: string): { text: string; truncated: boolean } {
	const lines = text.split("\n");
	let kept = lines.length > EXCERPT_LINES ? lines.slice(-EXCERPT_LINES).join("\n") : text;
	if (kept.length > EXCERPT_CHARS) kept = kept.slice(-EXCERPT_CHARS);
	return { text: kept, truncated: kept.length < text.length };
}

function toolDetails(raw: unknown): unknown {
	return JsonObject.check(raw) ? raw.details : undefined;
}

function pulledCommand(raw: unknown): BackgroundCommandCompletionDetails | undefined {
	const details = toolDetails(raw);
	if (!isBackgroundCommandOutputDetails(details)) return undefined;
	const { command: _command, status: current, finishedAt, ...run } = details.snapshot;
	const status = BACKGROUND_COMMAND_TERMINAL_STATUSES.find((terminal) => terminal === current);
	if (status === undefined || finishedAt === undefined) return undefined;
	const shown = excerpt(details.output.text);
	return {
		...run,
		status,
		finishedAt,
		output: { text: shown.text, truncated: details.output.truncated || shown.truncated },
		delivery: "run",
	};
}

export function pulledResult(
	toolName: string,
	args: Record<string, unknown>,
	tool: ToolResultState | undefined,
): PulledResult | undefined {
	if (tool?.status !== "done") return undefined;
	if (toolName === "get_subagent_result") {
		const details = toolDetails(tool.raw);
		if (!isDelegationRunDetails(details)) return undefined;
		if (details.status === "queued" || details.status === "running") return undefined;
		return {
			kind: "subagentCompletion",
			key: `subagent:${details.childSessionId}`,
			details: { ...details, delivery: "run" },
			text: parseToolResultContent(tool.raw).text,
		};
	}
	if (
		toolName === "background_command" &&
		strArg<ToolInputs["background_command"]>(args, "action") === "output"
	) {
		const details = pulledCommand(tool.raw);
		return details
			? { kind: "backgroundCommandCompletion", key: `command:${details.id}`, details }
			: undefined;
	}
	return undefined;
}
