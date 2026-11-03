import type {
	SessionId,
	WsChannel,
	WsChannelPayload,
	WsEnvelope,
	WsMethodName,
	WsParams,
	WsResult,
} from "@thinkrail/contracts";
import {
	PROTOCOL_VERSION,
	parseEnvelope,
	pushFailure,
	resultFailure,
	WS_CHANNELS,
} from "@thinkrail/contracts";
import { t } from "@thinkrail/locales/react";
import { randomId } from "../lib";
import { RequestError, RequestTimeoutError } from "./requestError";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
type PushHandler = (data: unknown) => void;

export interface TransportOptions {
	url?: string;
	onStatus?: (status: ConnectionStatus) => void;
}

interface TransportDispatchHooks {
	beforeDispatch?: (message: WsEnvelope) => void;
	onInvalidReply?: (method: WsMethodName) => void;
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
	sessionId?: SessionId;
	timeoutMs?: number;
}

export class WsTransport {
	private ws: WebSocket | null = null;
	private readonly url: string;
	private readonly onStatus: ((status: ConnectionStatus) => void) | undefined;
	private readonly hooks: TransportDispatchHooks;
	private seq = 0;
	private readonly pending = new Map<
		string,
		{
			method: WsMethodName;
			frame: string;
			resolve: (v: unknown) => void;
			reject: (e: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	private readonly subscribers = new Map<string, Set<PushHandler>>();
	private readonly latest = new Map<string, unknown>();
	private readonly warnedChannels = new Set<string>();
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
				resolve: resolve as (v: unknown) => void,
				reject,
				timer,
			});
			this.sendFrame(frame);
		});
	}

	subscribe<C extends WsChannel>(
		channel: C,
		handler: (data: WsChannelPayload<C>) => void,
	): () => void {
		const untyped = handler as PushHandler;
		let set = this.subscribers.get(channel);
		if (!set) {
			set = new Set();
			this.subscribers.set(channel, set);
		}
		set.add(untyped);
		if (this.latest.has(channel)) untyped(this.latest.get(channel));
		return () => {
			this.subscribers.get(channel)?.delete(untyped);
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
		const msg = parseEnvelope(raw);
		if (!msg) {
			console.warn("dropped a host frame that is not a valid envelope");
			return;
		}
		if ("channel" in msg) {
			const failure = pushFailure(msg.channel, msg.data);
			if (failure) {
				this.warnDroppedPush(msg.channel, failure);
				return;
			}
			this.hooks.beforeDispatch?.(msg);
			if (!NON_REPLAYABLE_CHANNELS.has(msg.channel)) this.latest.set(msg.channel, msg.data);
			const set = this.subscribers.get(msg.channel);
			if (set) for (const handler of set) handler(msg.data);
			return;
		}
		this.hooks.beforeDispatch?.(msg);
		this.queueAck(msg.id);
		const entry = this.pending.get(msg.id);
		if (!entry) return;
		clearTimeout(entry.timer);
		this.pending.delete(msg.id);
		if (msg.ok) {
			const failure = resultFailure(entry.method, msg.result);
			if (!failure) {
				entry.resolve(msg.result);
				return;
			}
			console.warn(`refused the reply to ${entry.method}:`, failure);
			this.hooks.onInvalidReply?.(entry.method);
			entry.reject(
				new RequestError(
					"INVALID_REPLY",
					t("app.transport.invalidReply", { method: entry.method }),
				),
			);
			return;
		}
		const message = msg.error ?? t("app.transport.requestFailed");
		entry.reject(msg.errorCode ? new RequestError(msg.errorCode, message) : new Error(message));
	}

	private warnDroppedPush(channel: string, failure: string): void {
		if (this.warnedChannels.has(channel)) return;
		this.warnedChannels.add(channel);
		console.warn(`dropped a push on ${channel}:`, failure);
	}
}

export function inferUrl(): string {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	return `${proto}//${location.host}/ws`;
}
