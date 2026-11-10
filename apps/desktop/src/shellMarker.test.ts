import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { DESKTOP_SHELL_GLOBAL } from "@thinkrail/contracts";
import { markDesktopShell, shellMarkerProbeScript } from "./shellMarker";

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
	const preload = markDesktopShell('throw new Error("preload stopped early");');
	expect(preload).toStartWith(`Object.defineProperty(globalThis, "${DESKTOP_SHELL_GLOBAL}"`);
	const context: Record<string, unknown> = {};
	expect(() => runInNewContext(preload, context)).toThrow("preload stopped early");
	expect(Object.getOwnPropertyDescriptor(context, DESKTOP_SHELL_GLOBAL)).toEqual({
		value: true,
		writable: false,
		configurable: false,
		enumerable: false,
	});
	expect(probe(context)).toBe("http://probe/marker-locked");
});

test("the artifact probe tells a missing or replaceable marker from the real one", () => {
	expect(probe({})).toBe("http://probe/marker-missing");
	expect(probe({ [DESKTOP_SHELL_GLOBAL]: true })).toBe("http://probe/marker-loose");
});
