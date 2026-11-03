import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	asProjectId,
	asSessionId,
	asWorkspaceId,
	PROTOCOL_VERSION,
	pushFailure,
	resultFailure,
	WS_CHANNELS,
	WS_METHODS,
} from "@thinkrail/contracts";
import { RequestError, wsErrorCode } from "./requestError";
import { WsTransport } from "./transport";

class TestWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: TestWebSocket[] = [];

	readonly url: string;
	readyState = TestWebSocket.CONNECTING;
	onopen: ((event: Event) => unknown) | null = null;
	onmessage: ((event: MessageEvent) => unknown) | null = null;
	onclose: ((event: CloseEvent) => unknown) | null = null;
	onerror: ((event: Event) => unknown) | null = null;
	readonly sent: string[] = [];

	constructor(url: string | URL) {
		this.url = String(url);
		TestWebSocket.instances.push(this);
	}

	open(): void {
		this.readyState = TestWebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		if (this.readyState !== TestWebSocket.OPEN) throw new Error("socket is not open");
		if (typeof data !== "string") throw new Error("test socket expects text frames");
		this.sent.push(data);
	}

	message(data: string): void {
		this.onmessage?.(new MessageEvent("message", { data }));
	}

	close(): void {
		if (this.readyState === TestWebSocket.CLOSED) return;
		this.readyState = TestWebSocket.CLOSED;
		this.onclose?.(new CloseEvent("close"));
	}
}

const originalWebSocket = globalThis.WebSocket;
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ClientFrame {
	id?: string;
	method?: string;
	ack?: string[];
	resume?: string[];
}
const parse = (frame: string): ClientFrame => JSON.parse(frame) as ClientFrame;
const requestsIn = (sent: readonly string[]): ClientFrame[] =>
	sent.map(parse).filter((frame) => frame.method !== undefined);
const acksIn = (sent: readonly string[]): string[] =>
	sent.flatMap((frame) => parse(frame).ack ?? []);
const resumesIn = (sent: readonly string[]): string[][] =>
	sent.map(parse).flatMap((frame) => (frame.resume === undefined ? [] : [frame.resume]));

beforeEach(() => {
	TestWebSocket.instances = [];
	globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
	globalThis.WebSocket = originalWebSocket;
});

test("advertises the client protocol version in the WebSocket handshake", () => {
	const transport = new WsTransport({ url: "ws://localhost:24242/ws?existing=value" });
	transport.connect();
	const socketUrl = new URL(TestWebSocket.instances[0]?.url ?? "");
	expect(socketUrl.searchParams.get("existing")).toBe("value");
	expect(socketUrl.searchParams.get("protocol")).toBe(String(PROTOCOL_VERSION));
	expect(socketUrl.searchParams.get("client")).toStartWith("client-");
});

describe("WsTransport channel replay", () => {
	test.each([
		[
			"resource invalidations deliver live but are not replayed on remount",
			WS_CHANNELS.sessionResourcesChanged,
			{ workspaceId: asWorkspaceId("workspace"), sessionId: asSessionId("session") },
		],
		[
			"does not replay a stale terminal takeover to a late terminal body",
			WS_CHANNELS.terminalDetached,
			{ workspaceId: asWorkspaceId("w1"), tabKey: "terminal-1" },
		],
		[
			"does not replay a provider invalidation to a late settings pane",
			WS_CHANNELS.providerChanged,
			{},
		],
		[
			"does not replay an addressed survey invitation to a late subscriber",
			WS_CHANNELS.feedbackInterview,
			{},
		],
	])("%s", (_name, channel, data) => {
		const transport = new WsTransport({ url: "ws://localhost:24242/ws" });
		transport.connect();
		const socket = TestWebSocket.instances[0];
		socket?.open();
		const received: unknown[] = [];
		transport.subscribe(channel, (payload) => received.push(payload));
		socket?.message(JSON.stringify({ channel, data }));
		expect(received).toEqual([data]);
		const replay: unknown[] = [];
		transport.subscribe(channel, (payload) => replay.push(payload));
		expect(replay).toEqual([]);
	});
});

describe("WsTransport dispatch barriers", () => {
	test("runs the barrier before channel subscribers and response settlement", async () => {
		const order: string[] = [];
		const transport = new WsTransport(
			{ url: "ws://localhost:24242/ws" },
			{ beforeDispatch: () => order.push("barrier") },
		);
		transport.subscribe(WS_CHANNELS.fontsChanged, () => order.push("push"));
		transport.connect();
		const socket = TestWebSocket.instances[0];
		socket?.open();

		socket?.message(JSON.stringify({ channel: WS_CHANNELS.fontsChanged, data: {} }));
		expect(order).toEqual(["barrier", "push"]);

		order.length = 0;
		const result = transport.request("project.list", {}).then((value) => {
			order.push("response");
			return value;
		});
		const id = requestsIn(socket?.sent ?? [])[0]?.id;
		socket?.message(JSON.stringify({ id, ok: true, result: [] }));
		expect(await result).toEqual([]);
		expect(order).toEqual(["barrier", "response"]);
	});
});

describe("WsTransport reconnect delivery", () => {
	test("replays an unresolved frame under the same id and resolves from the replacement socket", async () => {
		const statuses: string[] = [];
		const transport = new WsTransport({
			url: "ws://localhost:24242/ws",
			onStatus: (status) => statuses.push(status),
		});
		const result = transport.request("project.list", {});
		let settled = false;
		void result.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		transport.connect();
		const first = TestWebSocket.instances[0];
		expect(first).toBeDefined();
		first?.open();
		const originalFrame = first?.sent.find((frame) => parse(frame).method !== undefined);
		expect(originalFrame).toBeDefined();
		const id = parse(originalFrame ?? "{}").id;

		first?.close();
		await tick(20);
		expect(settled).toBe(false);

		await tick(520);
		const replacement = TestWebSocket.instances[1];
		expect(replacement).toBeDefined();
		replacement?.open();
		expect(replacement?.sent).toEqual([JSON.stringify({ resume: [id] }), originalFrame ?? ""]);

		replacement?.message(JSON.stringify({ id, ok: true, result: [] }));
		expect(await result).toEqual([]);
		expect(statuses).toEqual([
			"connecting",
			"connected",
			"disconnected",
			"connecting",
			"connected",
		]);
	});
});

describe("WsTransport response receipts", () => {
	test("acknowledges each response, batching a burst into one frame", async () => {
		const transport = new WsTransport({ url: "ws://localhost:24242/ws" });
		transport.connect();
		const socket = TestWebSocket.instances[0];
		socket?.open();

		const first = transport.request("project.list", {});
		const second = transport.request("workspace.list", { projectId: asProjectId("p1") });
		const ids = requestsIn(socket?.sent ?? []).map((frame) => frame.id ?? "");
		expect(ids).toHaveLength(2);
		const before = socket?.sent.length ?? 0;

		socket?.message(JSON.stringify({ id: ids[0], ok: true, result: [] }));
		socket?.message(JSON.stringify({ id: ids[1], ok: true, result: [] }));
		await Promise.all([first, second]);
		await tick(0);

		expect(acksIn(socket?.sent ?? [])).toEqual(ids);
		expect((socket?.sent.length ?? 0) - before).toBe(1);
	});

	test("a receipt lost with its socket is repaired by the reconnect reconciliation", async () => {
		const transport = new WsTransport({ url: "ws://localhost:24242/ws" });
		transport.connect();
		const first = TestWebSocket.instances[0];
		first?.open();

		const result = transport.request("project.list", {});
		const id = requestsIn(first?.sent ?? [])[0]?.id;
		first?.message(JSON.stringify({ id, ok: true, result: [] }));
		first?.close();
		expect(await result).toEqual([]);
		expect(acksIn(first?.sent ?? [])).toEqual([]);

		await tick(520);
		const replacement = TestWebSocket.instances[1];
		replacement?.open();
		await tick(0);

		expect(acksIn(replacement?.sent ?? [])).toEqual([]);
		expect(resumesIn(replacement?.sent ?? [])).toEqual([[]]);
	});

	test("the reconciliation names every unresolved id, including ones queued while offline", async () => {
		const transport = new WsTransport({ url: "ws://localhost:24242/ws" });
		transport.connect();
		const first = TestWebSocket.instances[0];
		first?.open();

		const resolved = transport.request("project.list", {});
		const stillOpen = transport.request("workspace.list", { projectId: asProjectId("p1") });
		const [resolvedId, stillOpenId] = requestsIn(first?.sent ?? []).map((frame) => frame.id ?? "");
		first?.message(JSON.stringify({ id: resolvedId, ok: true, result: [] }));
		expect(await resolved).toEqual([]);
		first?.close();

		const queued = transport.request("git.status", { workspaceId: asWorkspaceId("w1") });
		await tick(520);
		const replacement = TestWebSocket.instances[1];
		replacement?.open();
		const queuedId = requestsIn(replacement?.sent ?? [])[1]?.id;

		expect(resumesIn(replacement?.sent ?? [])).toEqual([[stillOpenId ?? "", queuedId ?? ""]]);
		expect(resumesIn(replacement?.sent ?? [])[0]).not.toContain(resolvedId);

		replacement?.message(JSON.stringify({ id: stillOpenId, ok: true, result: [] }));
		replacement?.message(
			JSON.stringify({ id: queuedId, ok: true, result: { branch: "main", changes: [] } }),
		);
		await Promise.all([stillOpen, queued]);
	});

	test("re-acknowledges a duplicate reply, whose first receipt may be what went missing", async () => {
		const transport = new WsTransport({ url: "ws://localhost:24242/ws" });
		transport.connect();
		const socket = TestWebSocket.instances[0];
		socket?.open();

		const result = transport.request("project.list", {});
		const id = requestsIn(socket?.sent ?? [])[0]?.id;
		socket?.message(JSON.stringify({ id, ok: true, result: [] }));
		expect(await result).toEqual([]);
		await tick(0);
		socket?.message(JSON.stringify({ id, ok: true, result: [] }));
		await tick(0);

		expect(acksIn(socket?.sent ?? [])).toEqual([id ?? "", id ?? ""]);
	});

	test("a request that times out is released to the host and left out of the next reconciliation", async () => {
		const transport = new WsTransport({ url: "ws://localhost:24242/ws" });
		transport.connect();
		const first = TestWebSocket.instances[0];
		first?.open();

		const result = transport.request("project.list", {}, { timeoutMs: 10 });
		const id = requestsIn(first?.sent ?? [])[0]?.id ?? "";
		await expect(result).rejects.toThrow();
		await tick(0);
		expect(acksIn(first?.sent ?? [])).toEqual([id]);

		first?.close();
		await tick(520);
		const replacement = TestWebSocket.instances[1];
		replacement?.open();
		expect(resumesIn(replacement?.sent ?? [])).toEqual([[]]);
		expect(requestsIn(replacement?.sent ?? [])).toEqual([]);
	});
});

describe("WsTransport wire checks", () => {
	const connected = (hooks: ConstructorParameters<typeof WsTransport>[1] = {}) => {
		const transport = new WsTransport({ url: "ws://localhost:24242/ws" }, hooks);
		transport.connect();
		const socket = TestWebSocket.instances.at(-1);
		socket?.open();
		return { transport, socket };
	};
	let warn: ReturnType<typeof spyOn>;

	beforeEach(() => {
		warn = spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warn.mockRestore();
	});

	test("a reply that breaks its schema rejects with a code, reports the method and is still acknowledged", async () => {
		const invalid: string[] = [];
		const { transport, socket } = connected({ onInvalidReply: (method) => invalid.push(method) });

		const result = transport.request("project.list", {});
		const id = requestsIn(socket?.sent ?? [])[0]?.id ?? "";
		socket?.message(JSON.stringify({ id, ok: true, result: { secret: "text" } }));

		const failure = await result.catch((error: unknown) => error);
		expect(wsErrorCode(failure)).toBe("INVALID_REPLY");
		expect(invalid).toEqual(["project.list"]);
		await tick(0);
		expect(acksIn(socket?.sent ?? [])).toEqual([id]);
	});

	test("a failed reply is not checked against the result schema", async () => {
		const invalid: string[] = [];
		const { transport, socket } = connected({ onInvalidReply: (method) => invalid.push(method) });

		const result = transport.request("project.list", {});
		const id = requestsIn(socket?.sent ?? [])[0]?.id;
		socket?.message(
			JSON.stringify({ id, ok: false, error: "nope", errorCode: "FROM_A_NEWER_HOST" }),
		);

		const failure = await result.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(RequestError);
		expect(failure).toMatchObject({ message: "nope", code: "FROM_A_NEWER_HOST" });
		expect(invalid).toEqual([]);
	});

	test("a bad push is dropped and later pushes still arrive, without a barrier or a cached value", () => {
		const barriers: unknown[] = [];
		const { transport, socket } = connected({
			beforeDispatch: (message) => barriers.push(message),
		});
		const good = {
			channel: WS_CHANNELS.workspaceRemoved,
			data: { projectId: asProjectId("p1"), id: "w1" },
		};
		const bad = {
			channel: WS_CHANNELS.workspaceRemoved,
			data: { projectId: asProjectId("p1"), id: 7 },
		};
		const seen: unknown[] = [];
		transport.subscribe(WS_CHANNELS.workspaceRemoved, (data) => seen.push(data));

		socket?.message(JSON.stringify(bad));
		socket?.message(JSON.stringify(bad));
		expect(seen).toEqual([]);
		expect(barriers).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(1);

		const late: unknown[] = [];
		transport.subscribe(WS_CHANNELS.workspaceRemoved, (data) => late.push(data));
		expect(late).toEqual([]);

		socket?.message(JSON.stringify(good));
		expect(seen).toEqual([good.data]);
	});

	test("a frame that is not an envelope, or a channel this client does not know, is dropped", () => {
		const barriers: unknown[] = [];
		const { socket } = connected({ beforeDispatch: (message) => barriers.push(message) });
		const frames = [
			"not json",
			"null",
			"7",
			JSON.stringify({ id: 7, ok: true }),
			JSON.stringify({ channel: 7, data: {} }),
			JSON.stringify({ channel: "constructor", data: {} }),
			JSON.stringify({ channel: "from.a.newer.host", data: {} }),
		];
		for (const frame of frames) expect(() => socket?.message(frame)).not.toThrow();
		expect(barriers).toEqual([]);
	});

	test("a later build's extra fields pass on every level of a reply and a push", async () => {
		const { transport, socket } = connected();
		const seen: unknown[] = [];
		transport.subscribe(WS_CHANNELS.workspaceRemoved, (data) => seen.push(data));
		const data = { projectId: asProjectId("p1"), id: "w1", extra: 1 };
		socket?.message(JSON.stringify({ channel: WS_CHANNELS.workspaceRemoved, data, extra: 1 }));
		expect(seen).toEqual([data]);

		const result = transport.request("host.update", {});
		const id = requestsIn(socket?.sent ?? [])[0]?.id;
		socket?.message(JSON.stringify({ id, ok: true, result: { ok: true, extra: 1 }, extra: 1 }));
		const value: unknown = await result;
		expect(value).toEqual({ ok: true, extra: 1 });
	});

	test("every welcome passes, so the handler can prompt", () => {
		const { transport, socket } = connected();
		const seen: unknown[] = [];
		transport.subscribe(WS_CHANNELS.serverWelcome, (data) => seen.push(data));
		const older = { protocolVersion: 60, projects: [{ id: "p1" }] };

		socket?.message(JSON.stringify({ channel: WS_CHANNELS.serverWelcome, data: older }));
		expect(seen).toEqual([older]);

		const unversioned = { projects: [] };
		socket?.message(JSON.stringify({ channel: WS_CHANNELS.serverWelcome, data: unversioned }));
		expect(seen).toEqual([older, unversioned]);

		const broken = { protocolVersion: PROTOCOL_VERSION, projects: { byId: {} } };
		socket?.message(JSON.stringify({ channel: WS_CHANNELS.serverWelcome, data: broken }));
		expect(seen).toEqual([older, unversioned, broken]);
	});

	test("a pi event with an unknown type passes: only its tag is checked", () => {
		const { transport, socket } = connected();
		const seen: unknown[] = [];
		transport.subscribe(WS_CHANNELS.piEvent, (data) => seen.push(data));
		const data = { sessionId: asSessionId("s1"), event: { type: "from_a_newer_pi", detail: {} } };
		socket?.message(JSON.stringify({ channel: WS_CHANNELS.piEvent, data }));
		socket?.message(
			JSON.stringify({
				channel: WS_CHANNELS.piEvent,
				data: { sessionId: asSessionId("s1"), event: {} },
			}),
		);
		expect(seen).toEqual([data]);
	});

	test("every method and channel schema compiles, because the check compiles on first use", () => {
		for (const method of Object.values(WS_METHODS)) {
			expect(() => resultFailure(method, null)).not.toThrow();
		}
		for (const channel of Object.values(WS_CHANNELS)) {
			expect(() => pushFailure(channel, null)).not.toThrow();
		}
	});
});
