import { compile } from "@earendil-works/pi-schema";
import {
	type HostUpdateNotice,
	type NativeUpdateBridge,
	type NativeUpdateFailedPhase,
	NativeUpdateState,
} from "@thinkrail/contracts";
import { t } from "@thinkrail/locales/react";
import { useEffect, useState } from "react";
import {
	bridgeCall,
	checkedListener,
	nativeGlobal,
	settled,
	settledAs,
	unsubscriber,
} from "../nativeBridge";
import { useAppStore } from "../store";

const NATIVE_UPDATES_GLOBAL = "__THINKRAIL_NATIVE_UPDATES__";

export type NativeUpdateAction = Exclude<NativeUpdateFailedPhase, null>;

export interface NativeUpdateRequestError {
	action: NativeUpdateAction;
	message: string;
}

export type UpdatesController =
	| {
			source: "native";
			state: NativeUpdateState;
			requestError: NativeUpdateRequestError | null;
			checkForUpdates(): void;
			downloadUpdate(): void;
			restartToUpdate(): void;
			dismissInstallResult(): void;
	  }
	| {
			source: "host";
			state: HostUpdateNotice;
			canRun: boolean;
			requestFailed: boolean;
			runUpdate(): void;
	  };

const isNativeUpdateState = compile(NativeUpdateState).check;

/** The update bridge at `value`, checking every value it hands back, or null without one. */
export function getNativeUpdateBridge(value: unknown): NativeUpdateBridge | null {
	const getState = bridgeCall(value, "getState");
	const checkForUpdates = bridgeCall(value, "checkForUpdates");
	const downloadUpdate = bridgeCall(value, "downloadUpdate");
	const restartToUpdate = bridgeCall(value, "restartToUpdate");
	const dismissInstallResult = bridgeCall(value, "dismissInstallResult");
	const subscribe = bridgeCall(value, "subscribe");
	if (
		!getState ||
		!checkForUpdates ||
		!downloadUpdate ||
		!restartToUpdate ||
		!dismissInstallResult ||
		!subscribe
	)
		return null;
	return {
		getState: () => settledAs(isNativeUpdateState, getState(), "update state"),
		checkForUpdates: () => settled(checkForUpdates()),
		downloadUpdate: () => settled(downloadUpdate()),
		restartToUpdate: () => settled(restartToUpdate()),
		dismissInstallResult: () => settled(dismissInstallResult()),
		subscribe: (listener) =>
			unsubscriber(
				subscribe(checkedListener(isNativeUpdateState, listener, "update state")),
				"update state unsubscribe",
			),
	};
}

function nativeUpdateErrorText(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message;
	if (typeof error === "string" && error.trim()) return error;
	return t("updates.nativeRequestFailed");
}

export function runNativeUpdateRequest(
	action: NativeUpdateAction,
	operation: () => Promise<void>,
	onError: (error: NativeUpdateRequestError) => void,
): void {
	const reject = (error: unknown): void => {
		onError({ action, message: nativeUpdateErrorText(error) });
	};
	try {
		void operation().catch(reject);
	} catch (error) {
		reject(error);
	}
}

export type HostUpdateRunner = () => Promise<unknown>;

export function runHostUpdateRequest(operation: HostUpdateRunner, onError: () => void): void {
	try {
		void operation().catch(() => onError());
	} catch {
		onError();
	}
}

export function subscribeToNativeUpdates(
	bridge: NativeUpdateBridge,
	onState: (state: NativeUpdateState) => void,
	onError: (error: string) => void,
): () => void {
	let active = true;
	let revision = -1;
	const accept = (state: NativeUpdateState): void => {
		if (!active || state.revision <= revision) return;
		revision = state.revision;
		onState(state);
	};
	const reject = (error: unknown): void => {
		if (active) onError(nativeUpdateErrorText(error));
	};
	let unsubscribe: (() => void) | undefined;
	try {
		unsubscribe = bridge.subscribe(accept);
	} catch (error) {
		reject(error);
	}
	try {
		void bridge.getState().then(accept, reject);
	} catch (error) {
		reject(error);
	}
	return () => {
		active = false;
		unsubscribe?.();
	};
}

export function selectUpdateSource(
	bridge: NativeUpdateBridge | null,
	hostUpdate: HostUpdateNotice | null,
): "native" | "host" | null {
	if (bridge) return "native";
	return hostUpdate === null ? null : "host";
}

export function hasNativeUpdateSurface(
	state: NativeUpdateState | null,
): state is NativeUpdateState {
	return state !== null && state.status !== "disabled";
}

export function useUpdates(hostUpdateRunner: HostUpdateRunner | null): UpdatesController | null {
	const [bridge] = useState(() => getNativeUpdateBridge(nativeGlobal(NATIVE_UPDATES_GLOBAL)));
	const [nativeState, setNativeState] = useState<NativeUpdateState | null>(null);
	const [nativeRequestError, setNativeRequestError] = useState<NativeUpdateRequestError | null>(
		null,
	);
	const [failedHostRequestFor, setFailedHostRequestFor] = useState<HostUpdateNotice | null>(null);
	const hostUpdate = useAppStore((state) => state.hostUpdate);

	useEffect(() => {
		if (!bridge) return;
		return subscribeToNativeUpdates(
			bridge,
			(next) => {
				setNativeState(next);
				setNativeRequestError(null);
			},
			() => {},
		);
	}, [bridge]);

	const source = selectUpdateSource(bridge, hostUpdate);
	if (source === "native" && bridge) {
		if (!hasNativeUpdateSurface(nativeState)) return null;
		const request = (action: NativeUpdateAction, operation: () => Promise<void>): void => {
			setNativeRequestError(null);
			runNativeUpdateRequest(action, operation, setNativeRequestError);
		};
		return {
			source,
			state: nativeState,
			requestError: nativeRequestError,
			checkForUpdates: () => request("check", () => bridge.checkForUpdates()),
			downloadUpdate: () => request("download", () => bridge.downloadUpdate()),
			restartToUpdate: () => request("install", () => bridge.restartToUpdate()),
			dismissInstallResult: () => {
				void bridge.dismissInstallResult().catch(() => {});
			},
		};
	}
	if (source === "host" && hostUpdate) {
		const canRun = hostUpdateRunner !== null && hostUpdate.status !== undefined;
		return {
			source,
			state: hostUpdate,
			canRun,
			requestFailed: failedHostRequestFor === hostUpdate,
			runUpdate: () => {
				if (!canRun || !hostUpdateRunner) return;
				setFailedHostRequestFor(null);
				runHostUpdateRequest(hostUpdateRunner, () => setFailedHostRequestFor(hostUpdate));
			},
		};
	}
	return null;
}
