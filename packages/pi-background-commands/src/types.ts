import type { BashOperations, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static, StaticObject } from "@earendil-works/pi-schema";
import type {
	BACKGROUND_COMMAND_COMPLETION_FIELDS,
	BACKGROUND_COMMAND_SNAPSHOT_FIELDS,
	BACKGROUND_COMMAND_TERMINAL_SNAPSHOT_FIELDS,
	BackgroundCommandOutput as BackgroundCommandOutputSchema,
} from "./wire";

export type { BackgroundCommandStatus, BackgroundCommandTerminalStatus } from "./wire";

export interface BackgroundCommandStart {
	command: string;
	name?: string;
	timeout?: number;
}

export interface BackgroundCommandContext {
	cwd: string;
	sessionFile?: string | undefined;
	model?: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id"> | undefined;
	thinkingLevel?: ExtensionContext["thinkingLevel"];
	shellPath?: string | undefined;
	commandPrefix?: string | undefined;
	exposeSessionEnvironment?: boolean;
}

export interface BackgroundCommandsBinding {
	sessionId: string;
	getContext(): BackgroundCommandContext;
	canDeliverCompletion?(): boolean;
}

export interface BackgroundCommandsOptions {
	createOperations?(options: { shellPath?: string }): BashOperations;
}

export type BackgroundCommandSnapshot = Readonly<
	StaticObject<typeof BACKGROUND_COMMAND_SNAPSHOT_FIELDS>
>;

/** A settled run: its status is terminal and `finishedAt` is set. */
export type BackgroundCommandTerminalSnapshot = Readonly<
	StaticObject<typeof BACKGROUND_COMMAND_TERMINAL_SNAPSHOT_FIELDS>
>;

export type BackgroundCommandOutput = Readonly<Static<typeof BackgroundCommandOutputSchema>>;

/** The `details` of a `background_command` `output` call. */
export interface BackgroundCommandOutputDetails {
	readonly snapshot: BackgroundCommandSnapshot;
	readonly output: BackgroundCommandOutput;
}

/** The `details` of a completion message. */
export type BackgroundCommandCompletionDetails = StaticObject<
	typeof BACKGROUND_COMMAND_COMPLETION_FIELDS
>;

export interface BackgroundCommandHandle {
	readonly id: string;
	readonly snapshot: BackgroundCommandSnapshot;
	readonly output: BackgroundCommandOutput | undefined;
	stop(): BackgroundCommandSnapshot;
	claimCompletion(): void;
}

export interface BackgroundCommandCompletion {
	readonly snapshot: BackgroundCommandTerminalSnapshot;
	readonly output: BackgroundCommandOutput;
}

export interface BackgroundCommandFlush {
	readonly atTurnEnd?: boolean;
}

export interface BackgroundCommandCompletionBinding {
	deliver(
		batch: readonly BackgroundCommandCompletion[],
		flush: BackgroundCommandFlush,
	): readonly BackgroundCommandCompletion[];
	canDeliverCompletion?(flush: BackgroundCommandFlush): boolean;
}

export interface BackgroundCommands {
	readonly sessionId: string;
	start(input: BackgroundCommandStart): BackgroundCommandHandle;
	list(): BackgroundCommandSnapshot[];
	find(id: string): BackgroundCommandHandle | undefined;
	onChange(listener: () => void): () => void;
	bindCompletion(binding: BackgroundCommandCompletionBinding): () => void;
	flushCompletions(flush?: BackgroundCommandFlush): void;
	dispose(options?: { timeoutMs?: number }): Promise<void>;
}
