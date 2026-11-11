import { lit, opt, type Static, str, union } from "@earendil-works/pi-schema";
import {
	BACKGROUND_COMMAND_COMPLETION_FIELDS,
	BACKGROUND_COMMAND_OUTPUT_DETAILS_FIELDS,
	BACKGROUND_COMMAND_SNAPSHOT_FIELDS,
	BackgroundCommandOutput,
	BackgroundCommandStatus,
} from "pi-background-commands/wire";
import { SessionId, StoredSessionId, WorkspaceId } from "./ids";
import { Ack, wireObj } from "./wire";

export { BACKGROUND_COMMAND_TERMINAL_STATUSES } from "pi-background-commands/wire";
export { BackgroundCommandStatus };

/** The host fields the wire adds to a run the package reports. */
const HOST_RUN_FIELDS = {
	sessionId: StoredSessionId,
	/** The host or the chat's teardown ended this run; `status` is then terminal (see `interruptedResource`). */
	interrupted: opt(lit(true)),
};

export const BackgroundCommandSummary = wireObj({
	...BACKGROUND_COMMAND_SNAPSHOT_FIELDS,
	...HOST_RUN_FIELDS,
});
export type BackgroundCommandSummary = Static<typeof BackgroundCommandSummary>;

export const BackgroundCommandOutputResult = union([
	wireObj({
		available: lit(true),
		command: BackgroundCommandSummary,
		output: BackgroundCommandOutput,
	}),
	wireObj({ available: lit(false) }),
]);
export type BackgroundCommandOutputResult = Static<typeof BackgroundCommandOutputResult>;

/** The `details` of a `background_command` `output` call, with the host's run fields on its snapshot. */
export const BackgroundCommandOutputDetails = wireObj({
	...BACKGROUND_COMMAND_OUTPUT_DETAILS_FIELDS,
	snapshot: BackgroundCommandSummary,
});

/** A finished run as its completion message carries it; `output` is the tail the agent saw. */
export const BackgroundCommandCompletionDetails = wireObj({
	...BACKGROUND_COMMAND_COMPLETION_FIELDS,
	...HOST_RUN_FIELDS,
});
export type BackgroundCommandCompletionDetails = Static<typeof BackgroundCommandCompletionDetails>;

const CommandTarget = wireObj({ workspaceId: WorkspaceId, sessionId: SessionId, commandId: str() });

export const BACKGROUND_COMMAND_METHODS = {
	"backgroundCommand.output": { params: CommandTarget, result: BackgroundCommandOutputResult },
	"backgroundCommand.stop": { params: CommandTarget, result: Ack },
};
