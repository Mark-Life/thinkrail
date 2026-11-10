export const FRAME_WATCH = {
	readyMs: 2000,
	confirmMs: 250,
	messages: 1000,
	windowMs: 1000,
	tailMs: 2000,
} as const;

const SENDER_HOPS = 8;

type FrameSender = "frame" | "other" | "untraced";

export function frameSender(
	event: Pick<MessageEvent, "source" | "origin">,
	frameWindow: unknown,
): FrameSender {
	let sender: unknown = event.source;
	for (let hop = 0; hop < SENDER_HOPS; hop += 1) {
		if (sender === frameWindow) return "frame";
		if (typeof sender !== "object" || sender === null) break;
		const parent: unknown = Reflect.get(sender, "parent");
		if (parent === sender) return "other";
		sender = parent;
	}
	return event.origin === "null" ? "untraced" : "other";
}

let tailEnd = 0;

export function createFrameWatch({
	readyMs = FRAME_WATCH.readyMs,
	confirmMs = FRAME_WATCH.confirmMs,
}: {
	readyMs?: number;
	confirmMs?: number;
} = {}) {
	let seq = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let windowStart = 0;
	let received = 0;
	let flooding = false;

	const stop = () => clearTimeout(timer);

	return {
		seq: () => seq,
		load(onDead: () => void) {
			stop();
			seq += 1;
			flooding = false;
			timer = setTimeout(() => {
				timer = setTimeout(onDead, confirmMs);
			}, readyMs);
			return seq;
		},
		ready: stop,
		stop,
		receive(at: number, sender: FrameSender = "frame"): "accept" | "flood" | "ignore" {
			if (flooding || sender === "other") return "ignore";
			if (sender === "untraced" && at < tailEnd) return "ignore";
			if (at - windowStart >= FRAME_WATCH.windowMs) {
				windowStart = at;
				received = 0;
			}
			received += 1;
			if (received <= FRAME_WATCH.messages) return "accept";
			flooding = true;
			tailEnd = at + FRAME_WATCH.tailMs;
			return "flood";
		},
	};
}
