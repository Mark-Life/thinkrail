import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { DESKTOP_SHELL_GLOBAL } from "@thinkrail/contracts";
import { desktopMockupScripts, markDesktopShell, shellMarkerProbeScript } from "./shellMarker";

function probe(context: Record<string, unknown>): string | undefined {
	const requests: string[] = [];
	class Image {
		set src(url: string) {
			requests.push(url);
		}
	}
	runInNewContext(shellMarkerProbeScript("http://probe/marker"), Object.assign(context, { Image }));
	return requests[0];
}

test("the marker is the first preload statement and survives a preload that throws", () => {
	const preload = markDesktopShell('throw new Error("preload stopped early");', {
		mockupScripts: true,
	});
	expect(preload).toStartWith(`Object.defineProperty(globalThis, "${DESKTOP_SHELL_GLOBAL}"`);
	const context: Record<string, unknown> = {};
	expect(() => runInNewContext(preload, context)).toThrow("preload stopped early");
	const marker = Object.getOwnPropertyDescriptor(context, DESKTOP_SHELL_GLOBAL);
	expect(marker).toMatchObject({ writable: false, configurable: false, enumerable: false });
	expect(marker?.value).toEqual({ mockupScripts: true });
	expect(Object.isFrozen(marker?.value)).toBe(true);
	expect(probe(context)).toBe("http://probe/marker-locked");
});

test("the artifact probe tells a missing or replaceable marker from the real one", () => {
	expect(probe({})).toBe("http://probe/marker-missing");
	expect(probe({ [DESKTOP_SHELL_GLOBAL]: true })).toBe("http://probe/marker-loose");
});

test("only macOS runs mockup scripts in the desktop shell", () => {
	expect(desktopMockupScripts("darwin")).toBe(true);
	expect(desktopMockupScripts("linux")).toBe(false);
	expect(desktopMockupScripts("win32")).toBe(false);
});
