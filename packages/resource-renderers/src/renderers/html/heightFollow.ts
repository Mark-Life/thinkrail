export interface HeightFollow {
	height: number | null;
	stopped: boolean;
	width: number;
	at: number;
	since: number;
	peak: number;
}

export interface HeightReading {
	height: number | null;
	width: number;
	at: number;
}

export const HEIGHT_RUN = { gapMs: 250, maxMs: 2000 } as const;

export const UNMEASURED_HEIGHT: HeightFollow = {
	height: null,
	stopped: false,
	width: 0,
	at: 0,
	since: 0,
	peak: 0,
};

export function restartHeightFollow(state: HeightFollow): HeightFollow {
	return { ...UNMEASURED_HEIGHT, height: state.height };
}

export function followHeight(state: HeightFollow, reading: HeightReading): HeightFollow {
	if (state.stopped) return state;
	if (reading.height === null) return { ...state, height: null, stopped: true };
	if (reading.height === state.height) return state;
	const continues =
		state.height !== null &&
		reading.width === state.width &&
		reading.at - state.at < HEIGHT_RUN.gapMs;
	const since = continues ? state.since : reading.at;
	const peak = continues ? Math.max(state.peak, reading.height) : reading.height;
	if (reading.at - since > HEIGHT_RUN.maxMs) return { ...state, height: peak, stopped: true };
	return {
		height: reading.height,
		stopped: false,
		width: reading.width,
		at: reading.at,
		since,
		peak,
	};
}

export interface FrameReading {
	flow: number;
	extent: number;
}

export const HEIGHT_PROBE = { height: 8192, step: 100, rounding: 1 } as const;

type HeightProbeStep = { readAt: number } | { height: number | null };

function heightProbeStep(readings: readonly FrameReading[]): HeightProbeStep {
	const [first, second, applied] = readings;
	if (!first) return { readAt: HEIGHT_PROBE.height };
	if (!second) return { readAt: HEIGHT_PROBE.height + HEIGHT_PROBE.step };
	if (Math.abs(second.flow - first.flow) > HEIGHT_PROBE.rounding) return { height: null };
	const probed = Math.max(first.flow, second.flow);
	if (probed >= HEIGHT_PROBE.height) return { height: probed };
	if (!applied) return { readAt: probed };
	if (Math.abs(applied.flow - probed) > HEIGHT_PROBE.rounding) return { height: null };
	return { height: Math.max(probed, applied.flow, applied.extent) };
}

export function frameIndependentHeight(
	readAt: (frameHeight: number) => FrameReading,
): number | null {
	const readings: FrameReading[] = [];
	for (;;) {
		const step = heightProbeStep(readings);
		if ("height" in step) return step.height;
		readings.push(readAt(step.readAt));
	}
}

export interface HeightProbe {
	readings: readonly FrameReading[];
	doubted: FrameReading | null;
	since: number;
}

export function startHeightProbe(at: number): { probe: HeightProbe; readAt: number } {
	return { probe: { readings: [], doubted: null, since: at }, readAt: HEIGHT_PROBE.height };
}

export function advanceHeightProbe(
	probe: HeightProbe,
	reading: FrameReading,
	at: number,
): { probe: HeightProbe; readAt: number } | { height: number | null } {
	if (probe.doubted) {
		const moved = Math.abs(reading.flow - probe.doubted.flow) > HEIGHT_PROBE.rounding;
		if (!moved || at - probe.since > HEIGHT_RUN.maxMs) return { height: null };
		return advanceHeightProbe({ ...probe, readings: [], doubted: null }, reading, at);
	}
	const readings = [...probe.readings, reading];
	const step = heightProbeStep(readings);
	if ("readAt" in step) return { probe: { ...probe, readings }, readAt: step.readAt };
	const [first] = readings;
	if (step.height !== null || !first) return step;
	return { probe: { ...probe, readings, doubted: first }, readAt: HEIGHT_PROBE.height };
}
