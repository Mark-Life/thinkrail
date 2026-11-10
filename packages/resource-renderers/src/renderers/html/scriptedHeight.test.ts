import { expect, test } from "bun:test";
import type { FrameReport } from "./frameMessages";
import { HEIGHT_PROBE } from "./heightFollow";
import { createScriptedHeight } from "./scriptedHeight";

const [PROBE, STEPPED] = [HEIGHT_PROBE.height, HEIGHT_PROBE.height + HEIGHT_PROBE.step];

function harness(
	document: (viewport: number) => number,
	{
		answerMs,
		held = null,
		remeasure,
	}: { answerMs?: number; held?: number | null; remeasure?: () => void } = {},
) {
	const frame = {
		clientWidth: 640,
		style: { height: "" },
		contentWindow: { postMessage: (message: unknown) => posted.push(message) },
	};
	const posted: unknown[] = [];
	const heights: (number | null)[] = [];
	const asked: string[] = [];
	const measuring = createScriptedHeight({
		height: held,
		...(answerMs === undefined ? {} : { answerMs }),
		...(remeasure ? { remeasure } : {}),
	});
	const report = (viewport: number, scroll = 0): FrameReport => {
		const flow = document(viewport);
		return { viewport, flow, extent: Math.max(flow, viewport), scroll };
	};
	const accept = (next: FrameReport) =>
		measuring.accept(frame, next, (height) => heights.push(height));
	return {
		frame,
		posted,
		heights,
		asked,
		measuring,
		report,
		accept,
		answer(limit = 20) {
			for (let step = 0; step < limit && frame.style.height !== ""; step += 1) {
				asked.push(frame.style.height);
				accept(report(Number.parseInt(frame.style.height, 10)));
			}
		},
	};
}

test("a report starts three readings and the frame gets its own height back", () => {
	const mockup = harness(() => 300);
	mockup.accept(mockup.report(456));
	expect(mockup.frame.style.height).toBe(`${PROBE}px`);
	mockup.answer();
	expect(mockup.asked).toEqual([`${PROBE}px`, `${STEPPED}px`, "300px"]);
	expect(mockup.heights).toEqual([300]);
	expect(mockup.frame.style.height).toBe("");
	expect(mockup.posted).toEqual([]);
});

test("a frame-sized document gives the height up and is left alone until a load", () => {
	const mockup = harness((viewport) => viewport + 16);
	mockup.accept(mockup.report(300));
	mockup.answer();
	expect(mockup.heights).toEqual([]);
	mockup.accept(mockup.report(456));
	expect(mockup.frame.style.height).toBe("");

	const fitted = harness(() => 300);
	fitted.accept(fitted.report(456));
	fitted.answer();
	const framed = (viewport: number) =>
		fitted.accept({ ...fitted.report(viewport), flow: viewport });
	framed(300);
	for (const viewport of [PROBE, STEPPED, PROBE]) framed(viewport);
	expect(fitted.heights).toEqual([300, null]);
	fitted.accept(fitted.report(480));
	expect(fitted.frame.style.height).toBe("");

	fitted.measuring.restart();
	fitted.accept(fitted.report(480));
	fitted.answer();
	expect(fitted.heights).toEqual([300, null, 300]);
});

test("the report that started the readings does not start them again", () => {
	const mockup = harness(() => 5000);
	const idle = mockup.report(1600);
	mockup.accept(idle);
	mockup.answer();
	expect(mockup.heights).toEqual([5000]);
	mockup.accept(idle);
	expect(mockup.frame.style.height).toBe("");
	mockup.accept({ ...idle, scroll: 120 });
	expect(mockup.frame.style.height).toBe("");
	mockup.accept({ ...idle, flow: 5040 });
	expect(mockup.frame.style.height).toBe(`${PROBE}px`);
});

test("a report for another frame height is not a reading", () => {
	const mockup = harness(() => 300);
	mockup.accept(mockup.report(456));
	mockup.accept(mockup.report(456));
	mockup.accept(mockup.report(STEPPED));
	expect(mockup.frame.style.height).toBe(`${PROBE}px`);
	mockup.accept(mockup.report(PROBE + HEIGHT_PROBE.rounding));
	expect(mockup.frame.style.height).toBe(`${STEPPED}px`);
});

test("the scroll offset from before the readings goes back to the frame", () => {
	const mockup = harness(() => 5000);
	mockup.accept(mockup.report(1600, 900));
	mockup.answer();
	expect(mockup.posted).toEqual([{ type: "thinkrail:scroll", top: 900 }]);
	expect(mockup.frame.style.height).toBe("");
});

test("a load keeps the height and drops readings in flight", () => {
	const mockup = harness(() => 300);
	mockup.accept(mockup.report(456));
	mockup.answer();
	mockup.accept({ ...mockup.report(300), flow: 340 });
	expect(mockup.frame.style.height).toBe(`${PROBE}px`);
	mockup.measuring.restart();
	expect(mockup.frame.style.height).toBe("");
	mockup.accept(mockup.report(PROBE));
	expect(mockup.frame.style.height).toBe(`${PROBE}px`);
	mockup.accept(mockup.report(PROBE));
	expect(mockup.frame.style.height).toBe(`${STEPPED}px`);
	mockup.answer();
	expect(mockup.heights).toEqual([300]);
});

test("a frame that does not answer gets its own height back", async () => {
	const mockup = harness(() => 300, { answerMs: 5 });
	const idle = mockup.report(456);
	mockup.accept(idle);
	expect(mockup.frame.style.height).toBe(`${PROBE}px`);
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(mockup.frame.style.height).toBe("");
	mockup.accept(idle);
	mockup.answer();
	expect(mockup.heights).toEqual([300]);

	mockup.accept({ ...idle, flow: 320 });
	mockup.measuring.stop();
	expect(mockup.frame.style.height).toBe("");
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a run that timed out asks the frame for a report and measures it, with no size change", async () => {
	let asks = 0;
	let answering = false;
	const mockup = harness(() => 900, {
		answerMs: 5,
		remeasure: () => {
			asks += 1;
			if (!answering) return;
			mockup.accept(idle);
			mockup.answer();
		},
	});
	const idle = mockup.report(480);
	mockup.accept(idle);
	expect(mockup.frame.style.height).toBe(`${PROBE}px`);
	answering = true;
	await pause(30);
	expect(asks).toBe(1);
	expect(mockup.heights).toEqual([900]);
	expect(mockup.frame.style.height).toBe("");
	await pause(30);
	expect(asks).toBe(1);
});

test("a frame that never answers is asked three times per load, and once more when the tab shows again", async () => {
	let asks = 0;
	const mockup = harness(() => 900, {
		answerMs: 5,
		remeasure: () => {
			asks += 1;
			mockup.accept(idle);
		},
	});
	const idle = mockup.report(480);
	mockup.measuring.resume();
	expect(asks).toBe(0);
	mockup.accept(idle);
	await pause(80);
	expect(asks).toBe(3);
	expect(mockup.frame.style.height).toBe("");
	expect(mockup.heights).toEqual([]);

	mockup.measuring.resume();
	expect(asks).toBe(4);
	mockup.answer();
	expect(mockup.heights).toEqual([900]);
	mockup.measuring.resume();
	expect(asks).toBe(4);

	mockup.accept({ ...idle, flow: 940 });
	await pause(80);
	expect(asks).toBe(7);
	mockup.measuring.restart();
	mockup.measuring.resume();
	expect(asks).toBe(7);
});

test("a frame mounted over a held height reports only a different verdict", () => {
	const same = harness(() => 300, { held: 300 });
	same.accept(same.report(300));
	same.answer();
	expect(same.heights).toEqual([]);

	const framed = harness((viewport) => viewport, { held: 300 });
	framed.accept(framed.report(300));
	framed.answer();
	expect(framed.heights).toEqual([null]);
});
