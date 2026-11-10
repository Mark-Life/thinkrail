import { MOCKUP_THEME_CHANGE_EVENT } from "@thinkrail/contracts";
import type { FrameReading } from "./heightFollow";

const THEME_MESSAGE = "thinkrail:theme";
const HEIGHT_MESSAGE = "thinkrail:height";
const READY_MESSAGE = "thinkrail:ready";
const SCROLL_MESSAGE = "thinkrail:scroll";

export const FRAME_BOOTSTRAP = `(() => {
	"use strict";
	const frame = window;
	frame.Object.defineProperty(frame, "name", {
		configurable: false,
		get: () => "",
		set: () => {},
	});
	const host = frame.parent;
	const post = host.postMessage.bind(host);
	const listen = frame.addEventListener.bind(frame);
	const dispatch = frame.dispatchEvent.bind(frame);
	const ThemeEvent = frame.Event;
	const Observer = frame.ResizeObserver;
	const ceil = frame.Math.ceil;
	const max = frame.Math.max;
	const viewport = frame.Object.getOwnPropertyDescriptor(frame, "innerHeight").get.bind(frame);
	const root = document.documentElement;
	const measure = root.getBoundingClientRect.bind(root);
	const scrollTo = root.scrollTo.bind(root);
	const script = document.currentScript;
	const theme = script.previousElementSibling;
	script.remove();
	let seq;
	let sent = "";
	let restore = null;
	const report = () => {
		if (seq === undefined) return;
		const height = viewport();
		const bar = max(0, height - root.clientHeight);
		const flow = ceil(measure().height) + bar;
		const extent = root.scrollHeight + bar;
		const scroll = max(0, root.scrollTop);
		const key = height + " " + flow + " " + extent + " " + scroll;
		if (key === sent) return;
		sent = key;
		post({ type: "${HEIGHT_MESSAGE}", seq, viewport: height, flow, extent, scroll }, "*");
	};
	const scrollBack = () => {
		if (restore !== null) scrollTo({ top: restore, behavior: "instant" });
	};
	listen("message", (event) => {
		const data = event.data;
		if (event.source !== host || !data) return;
		if (data.type === "${SCROLL_MESSAGE}" && typeof data.top === "number") {
			restore = data.top;
			scrollBack();
			if (root.scrollTop > restore - 1) restore = null;
			return;
		}
		if (data.type !== "${THEME_MESSAGE}" || typeof data.css !== "string") return;
		const changed = theme.textContent !== data.css;
		if (changed) theme.textContent = data.css;
		if (typeof data.seq === "number") {
			seq = data.seq;
			post({ type: "${READY_MESSAGE}", seq }, "*");
			sent = "";
			report();
		}
		if (changed) dispatch(new ThemeEvent("${MOCKUP_THEME_CHANGE_EVENT}"));
	});
	listen("resize", () => {
		scrollBack();
		restore = null;
		report();
	});
	listen("scroll", report);
	listen(
		"click",
		(event) => {
			for (const node of event.composedPath()) {
				const name = node.localName;
				if (
					(name === "a" || name === "area") &&
					(node.hasAttribute("href") || node.hasAttribute("xlink:href"))
				) {
					event.preventDefault();
					return;
				}
			}
		},
		true,
	);
	new Observer(report).observe(root);
})();`;

export function themeMessage(css: string, seq?: number) {
	return seq === undefined ? { type: THEME_MESSAGE, css } : { type: THEME_MESSAGE, css, seq };
}

export function scrollMessage(top: number) {
	return { type: SCROLL_MESSAGE, top };
}

export interface FrameReport extends FrameReading {
	viewport: number;
	scroll: number;
}

type FrameMessage = { kind: "ready" } | { kind: "height"; report: FrameReport };

function measure(data: object, name: keyof FrameReport): number | null {
	const value: unknown = Reflect.get(data, name);
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function acceptFrameMessage(
	event: Pick<MessageEvent, "source" | "data">,
	frame: { window: unknown; seq: number },
): FrameMessage | null {
	if (!frame.window || event.source !== frame.window) return null;
	const data: unknown = event.data;
	if (typeof data !== "object" || data === null) return null;
	const type: unknown = Reflect.get(data, "type");
	if (Reflect.get(data, "seq") !== frame.seq) return null;
	if (type === READY_MESSAGE) return { kind: "ready" };
	if (type !== HEIGHT_MESSAGE) return null;
	const viewport = measure(data, "viewport");
	const flow = measure(data, "flow");
	const extent = measure(data, "extent");
	const scroll = measure(data, "scroll");
	if (viewport === null || flow === null || extent === null || scroll === null) return null;
	return { kind: "height", report: { viewport, flow, extent, scroll } };
}
