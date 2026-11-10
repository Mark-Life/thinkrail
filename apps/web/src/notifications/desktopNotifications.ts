import type { NativeNotificationBridge } from "@thinkrail/contracts";
import { bridgeCall, nativeGlobal, returnedAs } from "../nativeBridge";
import type { NotificationChannel } from "./channel";
import { isWindowFocused } from "./webNotifications";

const NATIVE_NOTIFICATIONS_GLOBAL = "__THINKRAIL_NATIVE_NOTIFICATIONS__";

const isBoolean = (value: unknown) => typeof value === "boolean";

/** The notification bridge at `value`, checking what it hands back, or null without one. */
export function getNativeNotificationBridge(value: unknown): NativeNotificationBridge | null {
	const show = bridgeCall(value, "show");
	const nativeFocus = bridgeCall(value, "isWindowFocused");
	if (!show) return null;
	return {
		show: (input) => void show(input),
		...(nativeFocus
			? {
					isWindowFocused: () =>
						returnedAs(isBoolean, nativeFocus(), "window focus", isWindowFocused()),
				}
			: {}),
	};
}

export function readNativeNotificationBridge(): NativeNotificationBridge | null {
	return getNativeNotificationBridge(nativeGlobal(NATIVE_NOTIFICATIONS_GLOBAL));
}

/**
 * The desktop channel: the native OS notification center via the Electrobun bridge. It uses the
 * `subtitle` (worktree) the web channel folds away, and the OS owns permission, so there is no browser
 * permission flow and no in-app preface. Electrobun click callbacks are not landed yet, so clicks are
 * ignored for now.
 */
export function createDesktopNotificationChannel(
	bridge: NativeNotificationBridge,
): NotificationChannel {
	return {
		kind: "os",
		permission: () => "granted",
		requestPermission: async () => "granted",
		isWindowFocused: bridge.isWindowFocused ?? isWindowFocused,
		show: (spec) => {
			bridge.show({
				title: spec.title,
				...(spec.subtitle ? { subtitle: spec.subtitle } : {}),
				body: spec.body,
				silent: false,
			});
		},
	};
}
