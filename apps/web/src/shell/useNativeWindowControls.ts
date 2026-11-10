import { compile } from "@earendil-works/pi-schema";
import { type NativeWindowControlsBridge, NativeWindowState } from "@thinkrail/contracts";
import { useEffect, useState } from "react";
import {
	bridgeCall,
	checkedListener,
	nativeGlobal,
	settled,
	settledAs,
	unsubscriber,
} from "../nativeBridge";

const NATIVE_WINDOW_CONTROLS_GLOBAL = "__THINKRAIL_NATIVE_WINDOW_CONTROLS__";
const isNativeWindowState = compile(NativeWindowState).check;

/** The window-controls bridge at `value`, checking every value it hands back, or null without one. */
export function getNativeWindowControlsBridge(value: unknown): NativeWindowControlsBridge | null {
	const getState = bridgeCall(value, "getState");
	const minimize = bridgeCall(value, "minimize");
	const toggleMaximize = bridgeCall(value, "toggleMaximize");
	const close = bridgeCall(value, "close");
	const subscribe = bridgeCall(value, "subscribe");
	if (!getState || !minimize || !toggleMaximize || !close || !subscribe) return null;
	return {
		getState: () => settledAs(isNativeWindowState, getState(), "window state"),
		minimize: () => settled(minimize()),
		toggleMaximize: () => settled(toggleMaximize()),
		close: () => settled(close()),
		subscribe: (listener) =>
			unsubscriber(
				subscribe(checkedListener(isNativeWindowState, listener, "window state")),
				"window state unsubscribe",
			),
	};
}

export type NativeWindowControlsController = {
	state: NativeWindowState;
	minimize(): void;
	toggleMaximize(): void;
	close(): void;
};

function reportNativeWindowControlsFailure(action: string, error: unknown): void {
	console.warn(`Could not ${action} the native window`, error);
}

function runNativeWindowControlsRequest(action: string, operation: () => Promise<void>): void {
	try {
		void operation().catch((error) => reportNativeWindowControlsFailure(action, error));
	} catch (error) {
		reportNativeWindowControlsFailure(action, error);
	}
}

export function subscribeToNativeWindowState(
	bridge: Pick<NativeWindowControlsBridge, "getState" | "subscribe">,
	onState: (state: NativeWindowState) => void,
): () => void {
	let active = true;
	let pushed = false;
	const unsubscribe = bridge.subscribe((next) => {
		if (!active) return;
		pushed = true;
		onState(next);
	});
	bridge.getState().then(
		(next) => {
			if (active && !pushed) onState(next);
		},
		(error) => reportNativeWindowControlsFailure("read", error),
	);
	return () => {
		active = false;
		unsubscribe();
	};
}

export function useNativeWindowControls(): NativeWindowControlsController | null {
	const [bridge] = useState(() =>
		getNativeWindowControlsBridge(nativeGlobal(NATIVE_WINDOW_CONTROLS_GLOBAL)),
	);
	const [state, setState] = useState<NativeWindowState | null>(null);

	useEffect(() => (bridge ? subscribeToNativeWindowState(bridge, setState) : undefined), [bridge]);

	if (!bridge || !state) return null;
	return {
		state,
		minimize: () => runNativeWindowControlsRequest("minimize", () => bridge.minimize()),
		toggleMaximize: () =>
			runNativeWindowControlsRequest("maximize or restore", () => bridge.toggleMaximize()),
		close: () => runNativeWindowControlsRequest("close", () => bridge.close()),
	};
}
