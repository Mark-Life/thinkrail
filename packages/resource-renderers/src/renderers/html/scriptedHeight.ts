import { type FrameReport, scrollMessage } from "./frameMessages";
import {
	advanceHeightProbe,
	followHeight,
	HEIGHT_PROBE,
	type HeightFollow,
	type HeightProbe,
	restartHeightFollow,
	startHeightProbe,
	UNMEASURED_HEIGHT,
} from "./heightFollow";

const PROBE_ANSWER_MS = 1000;
const PROBE_RETRIES = 3;

type ProbedFrame = Pick<HTMLIFrameElement, "clientWidth"> & {
	style: Pick<CSSStyleDeclaration, "height">;
	contentWindow: Pick<Window, "postMessage"> | null;
};

interface Probing {
	frame: ProbedFrame;
	probe: HeightProbe;
	viewport: number;
	timer: ReturnType<typeof setTimeout>;
}

export function createScriptedHeight({
	height = null,
	answerMs = PROBE_ANSWER_MS,
	remeasure,
}: {
	height?: number | null;
	answerMs?: number;
	remeasure?: (frame: ProbedFrame) => void;
} = {}) {
	let follow: HeightFollow = { ...UNMEASURED_HEIGHT, height };
	let probing: Probing | null = null;
	let started: FrameReport | null = null;
	let scroll = 0;
	let retries = 0;
	let unanswered: ProbedFrame | null = null;

	const release = () => {
		if (!probing) return;
		clearTimeout(probing.timer);
		probing.frame.style.height = "";
		probing = null;
	};

	const abandon = () => {
		release();
		started = null;
	};

	const forget = () => {
		abandon();
		retries = 0;
		unanswered = null;
	};

	const timeOut = (frame: ProbedFrame) => {
		abandon();
		unanswered = frame;
		if (retries >= PROBE_RETRIES) return;
		retries += 1;
		remeasure?.(frame);
	};

	const readAt = (frame: ProbedFrame, probe: HeightProbe, viewport: number) => {
		if (probing) clearTimeout(probing.timer);
		frame.style.height = `${viewport}px`;
		probing = { frame, probe, viewport, timer: setTimeout(() => timeOut(frame), answerMs) };
	};

	const settle = (
		frame: ProbedFrame,
		measured: number | null,
		onHeight: (height: number | null) => void,
	) => {
		const previous = follow;
		follow = followHeight(previous, {
			height: measured,
			width: frame.clientWidth,
			at: performance.now(),
		});
		if (scroll > 0) frame.contentWindow?.postMessage(scrollMessage(scroll), "*");
		release();
		retries = 0;
		unanswered = null;
		if (follow.height !== previous.height) onHeight(follow.height);
	};

	return {
		restart() {
			forget();
			scroll = 0;
			follow = restartHeightFollow(follow);
		},
		stop: forget,
		resume() {
			if (!unanswered || probing) return;
			retries = 0;
			remeasure?.(unanswered);
		},
		accept(frame: ProbedFrame, report: FrameReport, onHeight: (height: number | null) => void) {
			if (follow.stopped) return;
			if (!probing) {
				scroll = report.scroll;
				if (
					started?.viewport === report.viewport &&
					started.flow === report.flow &&
					started.extent === report.extent
				) {
					return;
				}
				started = report;
				const first = startHeightProbe(performance.now());
				readAt(frame, first.probe, first.readAt);
				return;
			}
			if (Math.abs(report.viewport - probing.viewport) > HEIGHT_PROBE.rounding) return;
			const progress = advanceHeightProbe(probing.probe, report, performance.now());
			if ("readAt" in progress) readAt(probing.frame, progress.probe, progress.readAt);
			else settle(probing.frame, progress.height, onHeight);
		},
	};
}
