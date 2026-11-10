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

export function frameIndependentHeight(
	readAt: (frameHeight: number) => FrameReading,
): number | null {
	const first = readAt(HEIGHT_PROBE.height).flow;
	const second = readAt(HEIGHT_PROBE.height + HEIGHT_PROBE.step).flow;
	if (Math.abs(second - first) > HEIGHT_PROBE.rounding) return null;
	const probed = Math.max(first, second);
	if (probed >= HEIGHT_PROBE.height) return probed;
	const applied = readAt(probed);
	if (Math.abs(applied.flow - probed) > HEIGHT_PROBE.rounding) return null;
	return Math.max(probed, applied.flow, applied.extent);
}
