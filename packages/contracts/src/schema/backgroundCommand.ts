import {
	bool,
	lit,
	nullable,
	num,
	oneOf,
	opt,
	type Static,
	str,
	union,
} from "@earendil-works/pi-schema";
import { SessionId, StoredSessionId, WorkspaceId } from "./ids";
import { CompletionDelivery } from "./subagent";
import { Ack, wireObj } from "./wire";

export const BackgroundCommandStatus = oneOf([
	"running",
	"stopping",
	"completed",
	"error",
	"stopped",
]);
export type BackgroundCommandStatus = Static<typeof BackgroundCommandStatus>;

/** Epoch milliseconds; the bounds also refuse `NaN` and `Infinity`. */
const EpochMs = num({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

const RUN_FIELDS = {
	id: str(),
	sessionId: StoredSessionId,
	name: str(),
	startedAt: EpochMs,
	exitCode: opt(nullable(num())),
	errorMessage: opt(str()),
	/** The host or the chat's teardown ended this run; `status` is then terminal (see `interruptedResource`). */
	interrupted: opt(lit(true)),
};

export const BackgroundCommandSummary = wireObj({
	...RUN_FIELDS,
	command: str(),
	status: BackgroundCommandStatus,
	finishedAt: opt(EpochMs),
});
export type BackgroundCommandSummary = Static<typeof BackgroundCommandSummary>;

const BackgroundCommandOutput = wireObj({ text: str(), truncated: bool() });

export const BackgroundCommandOutputResult = union([
	wireObj({
		available: lit(true),
		command: BackgroundCommandSummary,
		output: BackgroundCommandOutput,
	}),
	wireObj({ available: lit(false) }),
]);
export type BackgroundCommandOutputResult = Static<typeof BackgroundCommandOutputResult>;

/** The `details` of a `background_command` `output` call. */
export const BackgroundCommandOutputDetails = wireObj({
	snapshot: BackgroundCommandSummary,
	output: BackgroundCommandOutput,
});

/** A finished run as its completion message carries it; `output` is the tail the agent saw. */
export const BackgroundCommandCompletionDetails = wireObj({
	...RUN_FIELDS,
	status: oneOf(["completed", "error", "stopped"]),
	finishedAt: EpochMs,
	output: BackgroundCommandOutput,
	delivery: opt(CompletionDelivery),
});
export type BackgroundCommandCompletionDetails = Static<typeof BackgroundCommandCompletionDetails>;

const CommandTarget = wireObj({ workspaceId: WorkspaceId, sessionId: SessionId, commandId: str() });

export const BACKGROUND_COMMAND_METHODS = {
	"backgroundCommand.output": { params: CommandTarget, result: BackgroundCommandOutputResult },
	"backgroundCommand.stop": { params: CommandTarget, result: Ack },
};
