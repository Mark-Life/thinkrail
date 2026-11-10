import { DESKTOP_SHELL_GLOBAL, type DesktopShellMarker } from "@thinkrail/contracts";

const NAME = JSON.stringify(DESKTOP_SHELL_GLOBAL);

export function desktopMockupScripts(platform: NodeJS.Platform): boolean {
	return platform === "darwin";
}

export function markDesktopShell(preloadSource: string, marker: DesktopShellMarker): string {
	return `Object.defineProperty(globalThis, ${NAME}, { value: Object.freeze(${JSON.stringify(marker)}), writable: false, configurable: false });\n${preloadSource}`;
}

export function shellMarkerProbeScript(url: string): string {
	return `(() => {
	const marker = Object.getOwnPropertyDescriptor(globalThis, ${NAME});
	const state = !marker ? "missing" : marker.writable || marker.configurable ? "loose" : "locked";
	new Image().src = ${JSON.stringify(url)} + "-" + state;
})();`;
}

const BRIDGES = ["eventBridge", "internalBridge", "hostBridge", "bunBridge"];

export function frameBridgeProbeScript(url: string): string {
	const frame = `(() => {
	const url = ${JSON.stringify(url)};
	const send = (name, message) => {
		try { window.webkit?.messageHandlers?.[name]?.postMessage(message); } catch {}
		try { window.chrome?.webview?.postMessage(message); } catch {}
	};
	for (let id = 0; id <= 8; id++) {
		for (const name of ${JSON.stringify(BRIDGES)}) {
			for (const eventName of ["new-window-open", "will-navigate"]) {
				const detail = url + "-forged-" + name;
				send(name, JSON.stringify({ id: "webviewEvent", type: "message", payload: { id, eventName, detail } }));
			}
		}
	}
	const globals = Object.getOwnPropertyNames(window).filter(
		(key) => /electrobun/i.test(key) && key !== "__electrobunConsoleForwardingInstalled",
	);
	new Image().src = url + "-ran-" + globals.length;
})();`;
	return `(() => {
	const marker = Object.getOwnPropertyDescriptor(globalThis, ${NAME})?.value;
	new Image().src = ${JSON.stringify(url)} + "-marker-" + (marker?.mockupScripts === true ? "scripts" : "no-scripts");
	const frame = document.createElement("iframe");
	frame.setAttribute("sandbox", "allow-scripts");
	frame.srcdoc = ${JSON.stringify("<!doctype html><script>")} + ${JSON.stringify(frame)} + ${JSON.stringify("</scr")} + "ipt>";
	document.body.append(frame);
})();`;
}
