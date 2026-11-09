import { compile, type Validator } from "@earendil-works/pi-schema";
import {
	parseWsPush,
	parseWsResult,
	type WsChannel,
	WsEnvelope,
	type WsMethodName,
	type WsParams,
	WsRequestFrame,
	WsResponse,
	type WsResult,
} from "@thinkrail/contracts";
import { E2E_PORT } from "./paths";

export class E2eWireTransientError extends Error {}

const envelope = compile(WsEnvelope);
const response = compile(WsResponse);
const requestFrame = compile(WsRequestFrame);

function parseJson(message: unknown): unknown {
	if (typeof message !== "string") return undefined;
	try {
		return JSON.parse(message);
	} catch {
		return undefined;
	}
}

export function parseFrame(message: unknown): WsEnvelope | null {
	const frame = parseJson(message);
	return envelope.check(frame) ? frame : null;
}

export function readReply(message: unknown, id: string): WsResponse | null {
	const frame = parseJson(message);
	return response.check(frame) && frame.id === id ? frame : null;
}

export function parseReply(message: unknown): WsResponse | null {
	const frame = parseJson(message);
	return response.check(frame) ? frame : null;
}

/** A client request frame of any method, before its params are checked. */
export function parseRequest(message: unknown): WsRequestFrame | null {
	const frame = parseJson(message);
	return requestFrame.check(frame) ? frame : null;
}

/**
 * A client request for `method`, with params `validator` accepts. Compile it once per spec from
 * `WS_METHOD_SCHEMAS[method].params`. @throws when the client sent params the schema refuses.
 */
export function readRequest<M extends WsMethodName>(
	message: unknown,
	method: M,
	validator: Validator<WsParams<M>>,
) {
	const frame = parseRequest(message);
	if (frame?.method !== method) return null;
	if (!validator.check(frame.params)) {
		throw new Error(`the client sent ${method} params its schema refuses`);
	}
	return { id: frame.id, params: frame.params };
}

/** A push on `channel` whose payload its schema accepts, else null. */
export function readPush<C extends WsChannel>(message: unknown, channel: C) {
	const frame = parseFrame(message);
	if (!frame || !("channel" in frame) || frame.channel !== channel) return null;
	const payload = parseWsPush(channel, frame.data);
	return payload.ok ? payload.value : null;
}

export class E2eWire {
	private sequence = 0;
	private readonly socket: WebSocket;

	private constructor(socket: WebSocket) {
		this.socket = socket;
	}

	static async connect(port = E2E_PORT, timeoutMs = 10_000): Promise<E2eWire> {
		const socket = new WebSocket(`ws://localhost:${port}/ws`);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				socket.close();
				reject(new E2eWireTransientError("Timed out connecting to the isolated host wire"));
			}, timeoutMs);
			const settle = (callback: () => void) => {
				clearTimeout(timer);
				socket.removeEventListener("open", onOpen);
				socket.removeEventListener("error", onError);
				callback();
			};
			const onOpen = () => settle(resolve);
			const onError = () =>
				settle(() =>
					reject(new E2eWireTransientError("Could not connect to the isolated host wire")),
				);
			socket.addEventListener("open", onOpen, { once: true });
			socket.addEventListener("error", onError, { once: true });
		});
		return new E2eWire(socket);
	}

	request<M extends WsMethodName>(method: M, params: WsParams<M>, timeoutMs = 10_000) {
		return this.send(method, params, timeoutMs);
	}

	requestUntyped<M extends WsMethodName>(method: M, params: unknown, timeoutMs = 10_000) {
		return this.send(method, params, timeoutMs);
	}

	private send<M extends WsMethodName>(
		method: M,
		params: unknown,
		timeoutMs: number,
	): Promise<WsResult<M>> {
		const id = `e2e_setup_${++this.sequence}`;
		const request = { id, method, params };
		return new Promise<WsResult<M>>((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new E2eWireTransientError(`Timed out waiting for ${method}`));
			}, timeoutMs);
			const cleanup = () => {
				clearTimeout(timer);
				this.socket.removeEventListener("message", onMessage);
				this.socket.removeEventListener("close", onClose);
				this.socket.removeEventListener("error", onError);
			};
			const onMessage = (event: MessageEvent) => {
				const reply = readReply(event.data, id);
				if (!reply) return;
				cleanup();
				if (!reply.ok) {
					reject(new Error(`${method} failed on the isolated host wire`));
					return;
				}
				const parsed = parseWsResult(method, reply.result);
				if (parsed.ok) resolve(parsed.value);
				else reject(new Error(parsed.problem));
			};
			const onClose = () => {
				cleanup();
				reject(new E2eWireTransientError("The isolated host wire closed during setup"));
			};
			const onError = () => {
				cleanup();
				reject(new E2eWireTransientError("The isolated host wire failed during setup"));
			};
			this.socket.addEventListener("message", onMessage);
			this.socket.addEventListener("close", onClose, { once: true });
			this.socket.addEventListener("error", onError, { once: true });
			this.socket.send(JSON.stringify(request));
		});
	}

	close(): void {
		this.socket.close();
	}
}
