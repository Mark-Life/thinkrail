import type {
	WsChannel,
	WsClientPayload,
	WsEnvelope,
	WsMethodName,
	WsParams,
	WsResult,
} from "@thinkrail/contracts";
import {
	PROTOCOL_VERSION,
	parseWsPush,
	parseWsResult,
	WS_CHANNELS,
	wsChannelOf,
} from "@thinkrail/contracts";
import { t } from "@thinkrail/locales/react";
import { randomId } from "../lib";
import { knownErrorCode, RequestError, RequestTimeoutError } from "./requestError";
import { readHostFrame } from "./wireChecks";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface TransportOptions {
	url?: string;
	onStatus?: (status: ConnectionStatus) => void;
}

/** A host frame the transport dropped. Each kind, and each channel, is reported once per page. */
export type DroppedFrame =
	| { readonly code: "INVALID_PUSH"; readonly channel: WsChannel }
	| { readonly code: "UNKNOWN_PUSH" }
	| { readonly code: "INVALID_ENVELOPE" };

/** The code a dropped frame is reported under: `INVALID_PUSH:<channel>`, `UNKNOWN_PUSH` or `INVALID_ENVELOPE`. */
export function droppedFrameCode(frame: DroppedFrame) {
	return frame.code === "INVALID_PUSH" ? `${frame.code}:${frame.channel}` : frame.code;
}

export interface TransportDispatchHooks {
	beforeDispatch?: (message: WsEnvelope) => void;
	onInvalidReply?: (method: WsMethodName) => void;
	onDroppedFrame?: (frame: DroppedFrame) => void;
}

interface PendingRequest {
	readonly method: WsMethodName;
	readonly frame: string;
	/** Resolves the request with its checked result, or returns why the result was refused. */
	readonly settle: (result: unknown) => string | null;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

interface ChannelSlot<T> {
	readonly handlers: Set<(data: T) => void>;
	latest: { readonly data: T } | undefined;
}

type ChannelSlots<C extends WsChannel> = { [K in C]?: ChannelSlot<WsClientPayload<K>> };

function slotOf<C extends WsChannel>(slots: ChannelSlots<C>, channel: C) {
	const known = slots[channel];
	if (known) return known;
	const created: ChannelSlot<WsClientPayload<C>> = { handlers: new Set(), latest: undefined };
	slots[channel] = created;
	return created;
}

const DEFAULT_TIMEOUT_MS = 60_000;

const NON_REPLAYABLE_CHANNELS: ReadonlySet<string> = new Set([
	WS_CHANNELS.terminalData,
	WS_CHANNELS.terminalExit,
	WS_CHANNELS.terminalDetached,
	WS_CHANNELS.sessionDeleted,
	WS_CHANNELS.sessionResourcesChanged,
	WS_CHANNELS.mcpStatus,
	WS_CHANNELS.providerChanged,
	WS_CHANNELS.feedbackInterview,
	WS_CHANNELS.feedbackGithubStar,
]);

let clientId: string | undefined;

function pageClientId(): string {
	if (clientId === undefined) clientId = randomId("client");
	return clientId;
}

function withClientId(url: string): string {
	const u = new URL(url);
	u.searchParams.set("client", pageClientId());
	u.searchParams.set("protocol", String(PROTOCOL_VERSION));
	return u.toString();
}

export interface RequestOptions {
	sessionId?: string;
	timeoutMs?: number;
}

export class WsTransport {
	private ws: WebSocket | null = null;
	private readonly url: string;
	private readonly onStatus: ((status: ConnectionStatus) => void) | undefined;
	private readonly hooks: TransportDispatchHooks;
	private seq = 0;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly channels: ChannelSlots<WsChannel> = {};
	private readonly dropped = new Set<string>();
	private ackQueue: string[] = [];
	private ackScheduled = false;
	private backoff = 500;

	constructor(opts: TransportOptions = {}, dispatchHooks: TransportDispatchHooks = {}) {
		this.url = opts.url ?? inferUrl();
		this.onStatus = opts.onStatus;
		this.hooks = dispatchHooks;
	}

	httpBase(): string {
		const u = new URL(this.url);
		u.protocol = u.protocol === "wss:" ? "https:" : "http:";
		return u.origin;
	}

	connect(): void {
		this.onStatus?.("connecting");
		const ws = new WebSocket(withClientId(this.url));
		this.ws = ws;
		ws.onopen = () => {
			if (this.ws !== ws) {
				ws.close();
				return;
			}
			this.backoff = 500;
			this.onStatus?.("connected");
			this.ackQueue = [];
			this.sendFrame(JSON.stringify({ resume: [...this.pending.keys()] }));
			for (const entry of this.pending.values()) this.sendFrame(entry.frame);
		};
		ws.onmessage = (ev) => this.handleMessage(ev.data);
		ws.onclose = () => {
			if (this.ws !== ws) return;
			this.ws = null;
			this.onStatus?.("disconnected");
			setTimeout(() => this.connect(), this.backoff);
			this.backoff = Math.min(this.backoff * 2, 10_000);
		};
		ws.onerror = () => ws.close();
	}

	request<M extends WsMethodName>(
		method: M,
		params: WsParams<M>,
		options: RequestOptions = {},
	): Promise<WsResult<M>> {
		const { sessionId, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
		const id = `trpi_${++this.seq}`;
		const frame = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
		return new Promise<WsResult<M>>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				if (this.ws?.readyState === WebSocket.OPEN) this.queueAck(id);
				reject(new RequestTimeoutError(t("app.transport.timedOut", { method })));
			}, timeoutMs);
			this.pending.set(id, {
				method,
				frame,
				settle: (result) => {
					const parsed = parseWsResult(method, result);
					if (!parsed.ok) return parsed.problem;
					resolve(parsed.value);
					return null;
				},
				reject,
				timer,
			});
			this.sendFrame(frame);
		});
	}

	subscribe<C extends WsChannel>(
		channel: C,
		handler: (data: WsClientPayload<C>) => void,
	): () => void {
		const slot = slotOf(this.channels, channel);
		slot.handlers.add(handler);
		if (slot.latest) handler(slot.latest.data);
		return () => {
			slot.handlers.delete(handler);
		};
	}

	private queueAck(id: string): void {
		this.ackQueue.push(id);
		if (this.ackScheduled) return;
		this.ackScheduled = true;
		queueMicrotask(() => {
			this.ackScheduled = false;
			this.flushAcks();
		});
	}

	private flushAcks(): void {
		if (this.ackQueue.length === 0 || this.ws?.readyState !== WebSocket.OPEN) return;
		const ack = this.ackQueue;
		this.ackQueue = [];
		this.sendFrame(JSON.stringify({ ack }));
	}

	private sendFrame(frame: string): void {
		if (this.ws?.readyState !== WebSocket.OPEN) return;
		try {
			this.ws.send(frame);
		} catch {
			this.ws.close();
		}
	}

	private handleMessage(raw: unknown): void {
		if (typeof raw !== "string") return;
		const frame = readHostFrame(raw);
		if (!frame.ok) {
			this.refuseFrame(frame.id);
			return;
		}
		const msg = frame.envelope;
		if ("channel" in msg) {
			const channel = wsChannelOf(msg.channel);
			if (channel === undefined) {
				this.drop({ code: "UNKNOWN_PUSH" }, `dropped a push on unknown channel ${msg.channel}`);
				return;
			}
			this.dispatchPush(channel, msg);
			return;
		}
		this.hooks.beforeDispatch?.(msg);
		this.queueAck(msg.id);
		const entry = this.takePending(msg.id);
		if (!entry) return;
		if (msg.ok) {
			const problem = entry.settle(msg.result);
			if (problem !== null) this.refuseReply(entry, problem);
			return;
		}
		const code = knownErrorCode(msg.errorCode);
		entry.reject(code ? new RequestError(code, msg.error) : new Error(msg.error));
	}

	private dispatchPush<C extends WsChannel>(
		channel: C,
		msg: Extract<WsEnvelope, { channel: string }>,
	): void {
		const parsed = parseWsPush(channel, msg.data);
		if (!parsed.ok) {
			this.drop(
				{ code: "INVALID_PUSH", channel },
				`dropped a push on ${channel}: ${parsed.problem}`,
			);
			return;
		}
		this.hooks.beforeDispatch?.(msg);
		const slot = slotOf(this.channels, channel);
		if (!NON_REPLAYABLE_CHANNELS.has(channel)) slot.latest = { data: parsed.value };
		for (const handler of slot.handlers) handler(parsed.value);
	}

	private takePending(id: string): PendingRequest | undefined {
		const entry = this.pending.get(id);
		if (!entry) return undefined;
		clearTimeout(entry.timer);
		this.pending.delete(id);
		return entry;
	}

	private refuseFrame(id: string | undefined): void {
		const entry = id === undefined ? undefined : this.takePending(id);
		if (id !== undefined && entry) {
			this.queueAck(id);
			this.refuseReply(entry, "the reply is not a valid envelope");
			return;
		}
		this.drop({ code: "INVALID_ENVELOPE" }, "dropped a host frame that is not a valid envelope");
	}

	private refuseReply(entry: PendingRequest, problem: string): void {
		console.warn(`refused the reply to ${entry.method}:`, problem);
		this.hooks.onInvalidReply?.(entry.method);
		entry.reject(
			new RequestError("INVALID_REPLY", t("app.transport.invalidReply", { method: entry.method })),
		);
	}

	private drop(frame: DroppedFrame, detail: string): void {
		const key = droppedFrameCode(frame);
		if (this.dropped.has(key)) return;
		this.dropped.add(key);
		console.warn(detail);
		this.hooks.onDroppedFrame?.(frame);
	}
}

export function inferUrl(): string {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	return `${proto}//${location.host}/ws`;
}
