export const SHIFT_REGIONS = [
	"chat-composer",
	"chat-scroll",
	"chat-toolbar",
	"center-tabs",
	"topbar",
	"workbench",
] as const;
export const TRACKED_ELEMENTS = ["chat-input", "chat-scroll", "chat-row"] as const;

export type ShiftRegion = (typeof SHIFT_REGIONS)[number] | "other";
type TrackedElement = (typeof TRACKED_ELEMENTS)[number];

interface LayoutShiftSample {
	at: number;
	value: number;
	hadRecentInput: boolean;
	regions: ShiftRegion[];
}

interface PageProbeSnapshot {
	layoutShiftSupported: boolean;
	typeableAt: number | null;
	transcriptAt: number | null;
	shifts: LayoutShiftSample[];
	movementPx: Record<TrackedElement, number>;
}

export interface WireFrame {
	at: number;
	direction: "sent" | "received";
	payload: string;
}

interface WireTimeline {
	watchReadyReplyMs: number;
	getMessagesSentMs: number;
	getMessagesReplyMs: number;
}

export interface WaterfallRecord {
	browser: string;
	wire: WireTimeline;
	chatViewChunkMs: number | null;
	page: PageProbeSnapshot;
}

interface ProbeHandle {
	snapshot: () => PageProbeSnapshot;
}

declare global {
	interface Window {
		__thinkrailWaterfallProbe?: ProbeHandle;
	}
}

export function installPageProbe(config: {
	regions: readonly string[];
	tracked: readonly string[];
}): void {
	interface ShiftSource {
		node: Node | null;
	}
	interface ShiftEntry extends PerformanceEntry {
		value: number;
		hadRecentInput: boolean;
		sources: readonly ShiftSource[];
	}

	const supported = PerformanceObserver.supportedEntryTypes.includes("layout-shift");
	const shifts: LayoutShiftSample[] = [];
	const movement: Record<string, number> = Object.fromEntries(config.tracked.map((n) => [n, 0]));
	const previous = new Map<string, { element: Element; x: number; y: number }>();
	let typeableAt: number | null = null;
	let transcriptAt: number | null = null;

	function regionOf(node: Node | null): ShiftRegion {
		let element = node instanceof Element ? node : (node?.parentElement ?? null);
		while (element) {
			const id = element.getAttribute("data-testid");
			if (id && config.regions.includes(id)) return id as ShiftRegion;
			element = element.parentElement;
		}
		return "other";
	}

	if (supported) {
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries() as ShiftEntry[]) {
				shifts.push({
					at: entry.startTime,
					value: entry.value,
					hadRecentInput: entry.hadRecentInput,
					regions: [...new Set(entry.sources.map((source) => regionOf(source.node)))],
				});
			}
		}).observe({ type: "layout-shift", buffered: true });
	}

	function trackedElement(name: string) {
		const all = document.querySelectorAll(`[data-testid="${name}"]`);
		return all[all.length - 1] ?? null;
	}

	function contentPosition(element: Element) {
		const rect = element.getBoundingClientRect();
		let x = rect.x;
		let y = rect.y;
		for (let parent = element.parentElement; parent; parent = parent.parentElement) {
			x += parent.scrollLeft;
			y += parent.scrollTop;
		}
		return { x, y };
	}

	function isTypeable() {
		const input = document.querySelector('[data-testid="chat-input"]');
		if (!(input instanceof HTMLTextAreaElement) || input.disabled || input.readOnly) return false;
		const rect = input.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	}

	function onFrame(now: number) {
		if (transcriptAt === null && document.querySelector('[data-testid="chat-message"]')) {
			transcriptAt = now;
		}
		if (typeableAt === null && isTypeable()) typeableAt = now;
		if (typeableAt !== null) {
			for (const name of config.tracked) {
				const element = trackedElement(name);
				if (!element) continue;
				const { x, y } = contentPosition(element);
				const last = previous.get(name);
				if (last && last.element === element) {
					const moved = Math.max(Math.abs(x - last.x), Math.abs(y - last.y));
					movement[name] = Math.max(movement[name] ?? 0, moved);
				}
				previous.set(name, { element, x, y });
			}
		}
		requestAnimationFrame(onFrame);
	}
	requestAnimationFrame(onFrame);

	window.__thinkrailWaterfallProbe = {
		snapshot: () => ({
			layoutShiftSupported: supported,
			typeableAt,
			transcriptAt,
			shifts: [...shifts],
			movementPx: { ...movement } as Record<TrackedElement, number>,
		}),
	};
}

interface ParsedFrame {
	at: number;
	direction: WireFrame["direction"];
	id: string;
	method: string | null;
	workspaceId: string | null;
}

function parseFrame(frame: WireFrame): ParsedFrame | null {
	let data: unknown;
	try {
		data = JSON.parse(frame.payload);
	} catch {
		return null;
	}
	if (typeof data !== "object" || data === null) return null;
	const record = data as Record<string, unknown>;
	if (typeof record.id !== "string") return null;
	const params = record.params as Record<string, unknown> | undefined;
	return {
		at: frame.at,
		direction: frame.direction,
		id: record.id,
		method: typeof record.method === "string" ? record.method : null,
		workspaceId: typeof params?.workspaceId === "string" ? params.workspaceId : null,
	};
}

export function wireTimeline(frames: readonly WireFrame[]): WireTimeline {
	const parsed = frames.flatMap((frame) => parseFrame(frame) ?? []);
	const replyAt = (id: string) =>
		parsed.find((frame) => frame.direction === "received" && frame.id === id && !frame.method)?.at;
	const getMessages = parsed.find(
		(frame) => frame.direction === "sent" && frame.method === "session.getMessages",
	);
	if (!getMessages) throw new Error("no session.getMessages request after restore");
	const watchReady = parsed.findLast(
		(frame) =>
			frame.direction === "sent" &&
			frame.method === "workspace.watchReady" &&
			frame.workspaceId === getMessages.workspaceId &&
			frame.at <= getMessages.at,
	);
	if (!watchReady) throw new Error("no workspace.watchReady request before session.getMessages");
	const watchReadyReplyMs = replyAt(watchReady.id);
	const getMessagesReplyMs = replyAt(getMessages.id);
	if (watchReadyReplyMs === undefined) throw new Error("workspace.watchReady got no reply");
	if (getMessagesReplyMs === undefined) throw new Error("session.getMessages got no reply");
	return { watchReadyReplyMs, getMessagesSentMs: getMessages.at, getMessagesReplyMs };
}
