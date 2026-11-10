import { createBackgroundCommandsExtension } from "./src/extension";

export {
	type BackgroundCommandInput,
	type BackgroundCommandsExtensionOptions,
	type BackgroundCommandToolArgs,
	createBackgroundCommandsExtension,
} from "./src/extension";
export { createBackgroundCommands } from "./src/service";
export default createBackgroundCommandsExtension();
export type {
	BackgroundCommandCompletion,
	BackgroundCommandCompletionBinding,
	BackgroundCommandCompletionDetails,
	BackgroundCommandContext,
	BackgroundCommandFlush,
	BackgroundCommandHandle,
	BackgroundCommandOutput,
	BackgroundCommandOutputDetails,
	BackgroundCommandSnapshot,
	BackgroundCommandStart,
	BackgroundCommandStatus,
	BackgroundCommands,
	BackgroundCommandsBinding,
	BackgroundCommandsOptions,
	BackgroundCommandTerminalSnapshot,
	BackgroundCommandTerminalStatus,
} from "./src/types";
export {
	BACKGROUND_COMMAND_COMPLETION_MESSAGE,
	type CompletionDelivery,
} from "./src/wire";
