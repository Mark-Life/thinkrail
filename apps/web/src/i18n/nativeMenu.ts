import type { NativeMenuBridge } from "@thinkrail/contracts";
import { DESKTOP_DIALOG_KEYS, DESKTOP_MENU_KEYS } from "@thinkrail/locales";
import { t } from "@thinkrail/locales/react";
import { bridgeCall, nativeGlobal } from "../nativeBridge";

export function pushNativeMenuLabels(): void {
	const keys = [...DESKTOP_MENU_KEYS, ...DESKTOP_DIALOG_KEYS];
	const setLabels: NativeMenuBridge["setLabels"] | null = bridgeCall(
		nativeGlobal("__THINKRAIL_NATIVE_MENU__"),
		"setLabels",
	);
	setLabels?.(Object.fromEntries(keys.map((key) => [key, t(key)])));
}
