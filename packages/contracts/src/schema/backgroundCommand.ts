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
import { Ack, wireObj } from "./wire";

export const BackgroundCommandStatus = oneOf([
	"running",
	"stopping",
	"completed",
	"error",
	"stopped",
]);
export type BackgroundCommandStatus = Static<typeof BackgroundCommandStatus>;

export const BackgroundCommandSummary = wireObj({
	id: str(),
	sessionId: str(),
	name: str(),
	command: str(),
	status: BackgroundCommandStatus,
	startedAt: num(),
	finishedAt: opt(num()),
	exitCode: opt(nullable(num())),
	errorMessage: opt(str()),
	/** The host or the chat's teardown ended this run; `status` is then terminal (see `interruptedResource`). */
	interrupted: opt(lit(true)),
});
export type BackgroundCommandSummary = Static<typeof BackgroundCommandSummary>;

export const BackgroundCommandOutputResult = union([
	wireObj({
		available: lit(true),
		command: BackgroundCommandSummary,
		output: wireObj({ text: str(), truncated: bool() }),
	}),
	wireObj({ available: lit(false) }),
]);
export type BackgroundCommandOutputResult = Static<typeof BackgroundCommandOutputResult>;

const CommandTarget = wireObj({ workspaceId: str(), sessionId: str(), commandId: str() });

export const BACKGROUND_COMMAND_METHODS = {
	"backgroundCommand.output": { params: CommandTarget, result: BackgroundCommandOutputResult },
	"backgroundCommand.stop": { params: CommandTarget, result: Ack },
};
