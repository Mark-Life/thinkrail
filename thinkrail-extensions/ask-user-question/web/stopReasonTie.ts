import type { NON_EXECUTABLE_STOP_REASONS as HOST_STOP_REASONS, Same } from "@thinkrail/contracts";
import type { NON_EXECUTABLE_STOP_REASONS } from "@thinkrail/pi-ask-user-question/core";

/** The extension's restart repair and the host's agree on which stop reasons keep tool calls from running. */
export type NonExecutableStopReasonTie = Same<
	(typeof NON_EXECUTABLE_STOP_REASONS)[number],
	(typeof HOST_STOP_REASONS)[number]
>;
