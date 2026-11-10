import type { NativeNotificationBridge } from "@thinkrail/contracts";
import { type BridgeMethods, readGlobalNativeBridge, readNativeBridge } from "../nativeBridge";
import type { NotificationChannel } from "./channel";
import { isWindowFocused } from "./webNotifications";

const NATIVE_NOTIFICATIONS_GLOBAL = "__THINKRAIL_NATIVE_NOTIFICATIONS__";

const NOTIFICATION_METHODS: BridgeMethods<NativeNotificationBridge> = {
	show: "required",
	isWindowFocused: "optional",
};

/** Shape-guard the optional native bridge the desktop preload freezes onto the global. */
export function getNativeNotificationBridge(value: unknown): NativeNotificationBridge | null {
	return readNativeBridge(value, NOTIFICATION_METHODS);
}

export function readNativeNotificationBridge(): NativeNotificationBridge | null {
	return readGlobalNativeBridge(NATIVE_NOTIFICATIONS_GLOBAL, NOTIFICATION_METHODS);
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
