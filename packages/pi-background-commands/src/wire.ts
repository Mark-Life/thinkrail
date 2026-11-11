import { bool, nullable, num, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";

export const BACKGROUND_COMMAND_STATUSES = [
	"running",
	"stopping",
	"completed",
	"error",
	"stopped",
] as const;
export const BackgroundCommandStatus = oneOf(BACKGROUND_COMMAND_STATUSES);
export type BackgroundCommandStatus = Static<typeof BackgroundCommandStatus>;

export const BACKGROUND_COMMAND_TERMINAL_STATUSES = [
	"completed",
	"error",
	"stopped",
] as const satisfies readonly BackgroundCommandStatus[];
export const BackgroundCommandTerminalStatus = oneOf(BACKGROUND_COMMAND_TERMINAL_STATUSES);
export type BackgroundCommandTerminalStatus = Static<typeof BackgroundCommandTerminalStatus>;

/** Epoch milliseconds; the bounds also refuse `NaN` and `Infinity`. */
const EpochMs = num({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const BACKGROUND_COMMAND_SNAPSHOT_FIELDS = {
	id: str(),
	sessionId: str(),
	name: str(),
	command: str(),
	status: BackgroundCommandStatus,
	startedAt: EpochMs,
	finishedAt: opt(EpochMs),
	exitCode: opt(nullable(num())),
	errorMessage: opt(str()),
};

export const BackgroundCommandOutput = obj({ text: str(), truncated: bool() }, { open: true });
export type BackgroundCommandOutput = Static<typeof BackgroundCommandOutput>;

/** The `details` of a `background_command` `output` call. */
export const BACKGROUND_COMMAND_OUTPUT_DETAILS_FIELDS = {
	snapshot: obj(BACKGROUND_COMMAND_SNAPSHOT_FIELDS, { open: true }),
	output: BackgroundCommandOutput,
};

export const COMPLETION_DELIVERIES = ["wake", "run", "appended"] as const;
export const CompletionDelivery = oneOf(COMPLETION_DELIVERIES);
export type CompletionDelivery = Static<typeof CompletionDelivery>;

export const BACKGROUND_COMMAND_TERMINAL_SNAPSHOT_FIELDS = {
	...BACKGROUND_COMMAND_SNAPSHOT_FIELDS,
	status: BackgroundCommandTerminalStatus,
	finishedAt: EpochMs,
};

const { command: _command, ...TERMINAL_FIELDS_WITHOUT_COMMAND } =
	BACKGROUND_COMMAND_TERMINAL_SNAPSHOT_FIELDS;

/** A finished run as its completion message carries it; `output` is the tail the agent saw. */
export const BACKGROUND_COMMAND_COMPLETION_FIELDS = {
	...TERMINAL_FIELDS_WITHOUT_COMMAND,
	output: BackgroundCommandOutput,
	delivery: opt(CompletionDelivery),
};

export const BACKGROUND_COMMAND_COMPLETION_MESSAGE = "background-command-completion";

/** The `background_command` tool's raw arguments, before the tool narrows them by `action`. */
export const BackgroundCommandToolArgs = obj({
	action: { ...oneOf(["start", "list", "output", "stop"]), type: "string" },
	command: opt(
		str({
			description: "Foreground shell command, for start only",
			minLength: 1,
			maxLength: 65536,
		}),
	),
	name: opt(str({ description: "Display name, for start only", maxLength: 200 })),
	timeout: opt(
		num({
			description: "Timeout in seconds, for start only; no default",
			exclusiveMinimum: 0,
			maximum: 2147483.647,
		}),
	),
	id: opt(str({ description: "Opaque command id returned by start, for output or stop only" })),
});
export type BackgroundCommandToolArgs = Static<typeof BackgroundCommandToolArgs>;
