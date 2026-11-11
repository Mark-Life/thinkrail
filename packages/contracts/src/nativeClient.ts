import type {
	NativeCommand,
	NativeNotificationInput,
	NativeQuitHint,
	NativeUpdateState,
	NativeWindowState,
} from "./schema";

export interface NativeUpdateBridge {
	getState(): Promise<NativeUpdateState>;
	checkForUpdates(): Promise<void>;
	downloadUpdate(): Promise<void>;
	restartToUpdate(): Promise<void>;
	dismissInstallResult(): Promise<void>;
	subscribe(listener: (state: NativeUpdateState) => void): () => void;
}

export interface NativeWindowControlsBridge {
	getState(): Promise<NativeWindowState>;
	minimize(): Promise<void>;
	toggleMaximize(): Promise<void>;
	close(): Promise<void>;
	subscribe(listener: (state: NativeWindowState) => void): () => void;
}

export interface NativeNotificationBridge {
	show(input: NativeNotificationInput): void;
	/** Whether the native window holds OS-level focus (true even when DevTools is focused). */
	isWindowFocused?: () => boolean;
}

export interface NativeShortcutsBridge {
	subscribeQuitHint(listener: (hint: NativeQuitHint) => void): () => void;
	subscribeCommand(listener: (command: NativeCommand) => void): () => void;
	quit(): Promise<void>;
}

/** Translated labels for the desktop's custom native menu items, keyed by catalog key. */
export interface NativeMenuBridge {
	setLabels(labels: Readonly<Record<string, string>>): void;
}
