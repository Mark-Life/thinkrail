import type {
	NativeCommand,
	NativeNotificationInput,
	NativeQuitHint,
	NativeUpdateState,
	NativeWindowState,
} from "@thinkrail/contracts";
import type {
	MenuLabelsChange,
	PageZoomGesture,
	PageZoomRequest,
	PreferenceRemove,
	PreferenceWrite,
	RouteChange,
} from "./rpcSchemas";
import type { WindowChromeGeometry } from "./windowChrome";

export type DesktopRpc = {
	bun: {
		requests: {
			getUpdateState: { params: undefined; response: NativeUpdateState };
			getWindowState: { params: undefined; response: NativeWindowState };
			minimizeWindow: { params: undefined; response: undefined };
			toggleMaximizeWindow: { params: undefined; response: undefined };
			closeWindow: { params: undefined; response: undefined };
			quitApp: { params: undefined; response: undefined };
			checkForUpdates: { params: undefined; response: undefined };
			downloadUpdate: { params: undefined; response: undefined };
			restartToUpdate: { params: undefined; response: undefined };
			dismissInstallResult: { params: undefined; response: undefined };
			showNotification: { params: NativeNotificationInput; response: undefined };
		};
		messages: {
			routeChanged: RouteChange;
			preferenceWrite: PreferenceWrite;
			preferenceRemove: PreferenceRemove;
			titleBarDoubleClick: undefined;
			pageZoomRequested: PageZoomRequest;
			pageZoomGestureRequested: PageZoomGesture;
			menuLabelsChanged: MenuLabelsChange;
		};
	};
	webview: {
		requests: Record<string, never>;
		messages: {
			updateStateChanged: NativeUpdateState;
			windowChromeChanged: WindowChromeGeometry;
			windowStateChanged: NativeWindowState;
			windowFocusChanged: { focused: boolean };
			quitHintChanged: { hint: NativeQuitHint };
			nativeCommand: { command: NativeCommand };
		};
	};
};
