import { expect, test } from "bun:test";
import {
	advanceHeightProbe,
	type FrameReading,
	followHeight,
	frameIndependentHeight,
	HEIGHT_PROBE,
	HEIGHT_RUN,
	type HeightFollow,
	restartHeightFollow,
	startHeightProbe,
	UNMEASURED_HEIGHT,
} from "./heightFollow";

const WIDTH = 640;

function feed(
	state: HeightFollow,
	readings: readonly (readonly [height: number | null, at: number, width?: number])[],
): HeightFollow {
	return readings.reduce(
		(current, [height, at, width = WIDTH]) => followHeight(current, { height, width, at }),
		state,
	);
}

test("a reading that does not depend on the frame is followed up and down", () => {
	const opened = feed(UNMEASURED_HEIGHT, [
		[300, 0],
		[500, 5000],
	]);
	expect(opened).toMatchObject({ height: 500, stopped: false });
	const closed = feed(opened, [[300, 9000]]);
	expect(closed).toMatchObject({ height: 300, stopped: false });
	expect(followHeight(closed, { height: 300, width: WIDTH, at: 9500 })).toBe(closed);
});

test("a frame-sized document gives up its height and is not followed again until a load", () => {
	const first = followHeight(UNMEASURED_HEIGHT, { height: null, width: WIDTH, at: 0 });
	expect(first).toMatchObject({ height: null, stopped: true });

	const later = feed(UNMEASURED_HEIGHT, [
		[300, 0],
		[null, 4000],
	]);
	expect(later).toMatchObject({ height: null, stopped: true });
	expect(followHeight(later, { height: 700, width: WIDTH, at: 8000 })).toBe(later);

	const reloaded = restartHeightFollow(later);
	expect(reloaded).toMatchObject({ height: null, stopped: false });
	expect(followHeight(reloaded, { height: 700, width: WIDTH, at: 9000 }).height).toBe(700);
});

test("a load keeps the last height until the new document is measured", () => {
	const fitted = feed(UNMEASURED_HEIGHT, [[300, 0]]);
	expect(restartHeightFollow(fitted)).toMatchObject({ height: 300, stopped: false });
});

test("a height that keeps changing stops at the tallest value of the run", () => {
	const frames = Math.ceil(HEIGHT_RUN.maxMs / 16) + 10;
	const animation = Array.from(
		{ length: frames },
		(_, frame) => [frame % 2 === 0 ? 400 : 250, 1000 + frame * 16] as const,
	);
	const running = feed(feed(UNMEASURED_HEIGHT, [[100, 0]]), animation.slice(0, 60));
	expect(running).toMatchObject({ height: 250, stopped: false });
	const stopped = feed(running, animation.slice(60));
	expect(stopped).toMatchObject({ height: 400, stopped: true });
	expect(followHeight(stopped, { height: 120, width: WIDTH, at: 9000 })).toBe(stopped);
});

test("a run ends with a pause or a width change, so a transition and a drag are followed", () => {
	const transition = Array.from(
		{ length: 30 },
		(_, frame) => [300 + frame * 5, 1000 + frame * 16] as const,
	);
	const settled = feed(feed(UNMEASURED_HEIGHT, [[300, 0]]), transition);
	expect(settled).toMatchObject({ height: 445, stopped: false });

	const paused = Array.from({ length: 20 }, (_, step) => [500 + step, 5000 + step * 300] as const);
	expect(feed(settled, paused)).toMatchObject({ height: 519, stopped: false });

	const drag = Array.from(
		{ length: 400 },
		(_, frame) => [600 + frame, 20_000 + frame * 16, WIDTH - frame] as const,
	);
	expect(feed(settled, drag)).toMatchObject({ height: 999, stopped: false });
});

function readings(document: (frameHeight: number) => FrameReading | number) {
	const frames: number[] = [];
	const height = frameIndependentHeight((frameHeight) => {
		frames.push(frameHeight);
		const reading = document(frameHeight);
		return typeof reading === "number"
			? { flow: reading, extent: Math.max(reading, frameHeight) }
			: reading;
	});
	return { height, frames };
}

test("a document that keeps its height at three frame heights is content-sized", () => {
	expect(readings(() => 300)).toEqual({
		height: 300,
		frames: [HEIGHT_PROBE.height, HEIGHT_PROBE.height + HEIGHT_PROBE.step, 300],
	});
});

test("a document sized from its frame has no content height", () => {
	expect(readings((frame) => frame).height).toBeNull();
	expect(readings((frame) => frame + 16).height).toBeNull();
	expect(readings((frame) => Math.ceil(frame / 100)).height).toBeNull();
	expect(readings((frame) => (frame < 400 ? 800 : 150)).height).toBeNull();
});

test("readings one pixel apart are the same height and the largest is kept", () => {
	expect(readings((frame) => (frame === 226 ? 227 : 226)).height).toBe(227);
	expect(readings((frame) => (frame === HEIGHT_PROBE.height ? 225 : 226)).height).toBe(226);
	expect(readings((frame) => (frame > 1000 ? 226 : 228)).height).toBeNull();
});

test("content out of the normal flow counts through the scroll extent at the read height", () => {
	const absolute = readings((frame) => ({ flow: 8, extent: Math.max(frame, 602) }));
	expect(absolute).toMatchObject({ height: 602, frames: { 2: 8 } });
	expect(readings((frame) => ({ flow: 8, extent: frame })).height).toBe(8);
});

test("a document taller than the probe is accepted from the two probe readings", () => {
	const narrowedByScrollbar = (frame: number) => (frame >= 16_153 ? 16_153 : 17_113);
	expect(readings(narrowedByScrollbar)).toEqual({
		height: 17_113,
		frames: [HEIGHT_PROBE.height, HEIGHT_PROBE.height + HEIGHT_PROBE.step],
	});
	expect(readings((frame) => frame * 2).height).toBeNull();
});

function probeOverTime(document: (frameHeight: number, at: number) => number, stepMs = 16) {
	const frames: number[] = [];
	let at = 0;
	let progress: ReturnType<typeof advanceHeightProbe> = startHeightProbe(at);
	while ("readAt" in progress) {
		frames.push(progress.readAt);
		at += stepMs;
		const flow = document(progress.readAt, at);
		progress = advanceHeightProbe(
			progress.probe,
			{ flow, extent: Math.max(flow, progress.readAt) },
			at,
		);
	}
	return { height: progress.height, frames };
}

const [PROBE, STEPPED] = [HEIGHT_PROBE.height, HEIGHT_PROBE.height + HEIGHT_PROBE.step];

test("readings taken one at a time follow the same three frame heights", () => {
	expect(probeOverTime(() => 300)).toEqual({ height: 300, frames: [PROBE, STEPPED, 300] });
	expect(probeOverTime(() => 17_113)).toEqual({ height: 17_113, frames: [PROBE, STEPPED] });
});

test("a frame-sized verdict counts only when the first frame height reads the same again", () => {
	expect(probeOverTime((frame) => frame + 16)).toEqual({
		height: null,
		frames: [PROBE, STEPPED, PROBE],
	});
	expect(probeOverTime((frame) => (frame < 400 ? 800 : 150))).toEqual({
		height: null,
		frames: [PROBE, STEPPED, 150, PROBE],
	});
});

test("content that changed between two readings starts the readings over", () => {
	expect(probeOverTime((_frame, at) => (at < 32 ? 300 : 340))).toEqual({
		height: 340,
		frames: [PROBE, STEPPED, PROBE, STEPPED, 340],
	});
	expect(probeOverTime((_frame, at) => (at < 48 ? 300 : 340))).toEqual({
		height: 340,
		frames: [PROBE, STEPPED, 300, PROBE, STEPPED, 340],
	});
});

test("content that never holds still for a whole run has no content height", () => {
	const moving = probeOverTime((_frame, at) => at);
	expect(moving.height).toBeNull();
	expect(moving.frames.length * 16).toBeGreaterThan(HEIGHT_RUN.maxMs);
	expect(moving.frames.length * 16).toBeLessThan(HEIGHT_RUN.maxMs + 100);
});
