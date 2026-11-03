import { afterEach, expect, spyOn, test } from "bun:test";
import { setDesktopErrorReporter } from "./errorReporting";
import { createPageZoomGestureHandler } from "./pageZoom";
import { checked, PageZoomGesture, PreferenceWrite } from "./rpcSchemas";

afterEach(() => setDesktopErrorReporter(null));

test("a refused message never reaches its handler and reports only a code", () => {
	const silence = spyOn(console, "error").mockImplementation(() => {});
	const reports: unknown[] = [];
	setDesktopErrorReporter((error) => reports.push(error));
	const handled: unknown[] = [];
	const handler = checked("preferenceWrite", PreferenceWrite, (payload) => handled.push(payload));

	expect(handler({ key: "density", value: "compact" })).toBeUndefined();
	expect(handler({ key: "density", value: "compact", later: 1 })).toBeUndefined();
	for (const malformed of [null, [], "density", { key: "density" }, { key: 1, value: "x" }]) {
		expect(handler(malformed)).toBeUndefined();
	}

	expect(handled).toEqual([
		{ key: "density", value: "compact" },
		{ key: "density", value: "compact", later: 1 },
	]);
	expect(reports).toHaveLength(5);
	expect(reports[0]).toMatchObject({ code: "NATIVE_RPC_INVALID" });
	silence.mockRestore();
});

test("a gesture with a bad scale leaves the page zoom alone", () => {
	const silence = spyOn(console, "error").mockImplementation(() => {});
	let zoom = 1.25;
	const handler = checked(
		"pageZoomGestureRequested",
		PageZoomGesture,
		createPageZoomGestureHandler({
			getPageZoom: () => zoom,
			setPageZoom: (next) => {
				zoom = next;
			},
		}),
	);

	handler({ phase: "start" });
	for (const scale of [null, Number.NaN, Number.POSITIVE_INFINITY, 0, -1, "2"]) {
		handler({ phase: "change", scale });
	}
	expect(zoom).toBe(1.25);
	handler({ phase: "change", scale: 1.2 });
	expect(zoom).toBe(1.5);
	silence.mockRestore();
});
