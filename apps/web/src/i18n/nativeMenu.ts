import type { NativeMenuBridge } from "@thinkrail/contracts";
import { DESKTOP_DIALOG_KEYS, DESKTOP_MENU_KEYS } from "@thinkrail/locales";
import { t } from "@thinkrail/locales/react";
import { type BridgeMethods, readGlobalNativeBridge } from "../nativeBridge";

const MENU_METHODS: BridgeMethods<NativeMenuBridge> = { setLabels: "required" };

export function pushNativeMenuLabels(): void {
	const keys = [...DESKTOP_MENU_KEYS, ...DESKTOP_DIALOG_KEYS];
	readGlobalNativeBridge("__THINKRAIL_NATIVE_MENU__", MENU_METHODS)?.setLabels(
		Object.fromEntries(keys.map((key) => [key, t(key)])),
	);
}
