import { DESKTOP_SHELL_GLOBAL } from "@thinkrail/contracts";

const NAME = JSON.stringify(DESKTOP_SHELL_GLOBAL);

export function markDesktopShell(preloadSource: string): string {
	return `Object.defineProperty(globalThis, ${NAME}, { value: true, writable: false, configurable: false });\n${preloadSource}`;
}

export function shellMarkerProbeScript(url: string): string {
	return `(() => {
	const marker = Object.getOwnPropertyDescriptor(globalThis, ${NAME});
	const state = !marker ? "missing" : marker.writable || marker.configurable ? "loose" : "locked";
	new Image().src = ${JSON.stringify(url)} + "-" + state;
})();`;
}
