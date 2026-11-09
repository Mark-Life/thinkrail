import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { SESSION_TOPICS_PROTOCOL_VERSION, WS_CHANNELS } from "@thinkrail/contracts";
import {
	configurePiRuntime,
	configurePiRuntimeFactory,
	createSession,
	promptSession,
	setSessionManagerFactory,
	setSessionPublisher,
	toWireModel,
} from "../agent";
import { resetAnalyticsForTests } from "../analytics";
import { resetJbcentralStateForTests } from "../auth";
import { saveWorkspaces } from "../persistence";
import { resetConfigCache } from "../settings";
import { setTurnPublisher } from "../turns";
import { createServer, type RunningServer } from "./server";

const saved = {
	THINKRAIL_DATA_DIR: process.env.THINKRAIL_DATA_DIR,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	PI_OFFLINE: process.env.PI_OFFLINE,
};
let directory: string;
let repo: string;
let server: RunningServer | undefined;
const sockets: WebSocket[] = [];

interface Frame {
	channel?: string;
	id?: string;
	ok?: boolean;
	data?: { sessionId?: string; event?: { type?: string } };
}

function sh(...args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "ignore", stderr: "pipe" });
	if (!result.success) throw new Error(result.stderr.toString());
}

beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "thinkrail-session-topics-"));
	process.env.THINKRAIL_DATA_DIR = join(directory, "data");
	process.env.PI_CODING_AGENT_DIR = join(directory, "pi");
	process.env.PI_OFFLINE = "1";
	repo = join(directory, "repo");
	mkdirSync(repo);
	sh("init", "-b", "main");
	sh("config", "user.email", "t@thinkrail.test");
	sh("config", "user.name", "test");
	sh("config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "README.md"), "# repo\n");
	sh("add", "-A");
	sh("commit", "-m", "init");
	saveWorkspaces([
		{
			id: "w1",
			projectId: "p1",
			kind: "default",
			name: "repo",
			branch: "main",
			baseBranch: "main",
			worktreePath: repo,
		},
	]);
	resetConfigCache();
	await resetJbcentralStateForTests();
	setSessionManagerFactory((cwd) => SessionManager.inMemory(cwd));
});

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.close();
	await server?.shutdown();
	server = undefined;
	setSessionPublisher(() => {});
	setTurnPublisher(() => {});
	setSessionManagerFactory((cwd) => SessionManager.create(cwd));
	resetAnalyticsForTests();
	resetConfigCache();
	await resetJbcentralStateForTests();
	configurePiRuntimeFactory();
	configurePiRuntime(null);
	rmSync(directory, { recursive: true, force: true });
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

async function startHost(sessionCount: number) {
	const model = {
		id: "topics",
		name: "Topics",
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
	const faux = createFauxCore({
		provider: "topics",
		api: "topics",
		models: [model],
		tokensPerSecond: 100_000,
	});
	faux.setResponses(Array.from({ length: 16 }, () => fauxAssistantMessage("Done.")));
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerProvider("topics", {
		api: faux.api,
		baseUrl: "http://faux.local",
		apiKey: "faux",
		streamSimple: faux.streamSimple,
		models: [{ ...model, api: faux.api }],
	});
	configurePiRuntime(null);
	configurePiRuntimeFactory(async () => runtime);
	server = await createServer({ port: 0, analytics: { mute: true } });
	const sessionIds: string[] = [];
	for (let i = 0; i < sessionCount; i++) {
		const { sessionId } = await createSession({
			cwd: repo,
			workspaceId: "w1",
			model: toWireModel(faux.getModel()),
		});
		sessionIds.push(sessionId);
	}
	return { port: server.port, sessionIds };
}

async function connect(port: number, client: string, protocol?: number) {
	const query = protocol === undefined ? "" : `&protocol=${protocol}`;
	const socket = new WebSocket(`ws://localhost:${port}/ws?client=${client}${query}`);
	sockets.push(socket);
	const frames: Frame[] = [];
	const replies = new Map<string, (frame: Frame) => void>();
	const watchers = new Set<() => void>();
	let next = 0;
	socket.addEventListener("message", (event) => {
		const frame = JSON.parse(String(event.data)) as Frame;
		frames.push(frame);
		if (frame.id) replies.get(frame.id)?.(frame);
		for (const notify of watchers) notify();
	});
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
	});
	const send = (method: string, params: unknown) => {
		next += 1;
		const id = `${client}-${crypto.randomUUID()}-${next}`;
		const reply = new Promise<Frame>((resolve) => replies.set(id, resolve));
		socket.send(JSON.stringify({ id, method, params }));
		return reply;
	};
	const piEvents = () => frames.filter((frame) => frame.channel === WS_CHANNELS.piEvent);
	const sessionsSeen = () => new Set(piEvents().map((frame) => frame.data?.sessionId));
	const settled = (sessionId: string) =>
		piEvents().some(
			(frame) => frame.data?.sessionId === sessionId && frame.data.event?.type === "agent_settled",
		);
	const waitSettled = (sessionId: string) =>
		new Promise<void>((resolve) => {
			const check = () => {
				if (!settled(sessionId)) return;
				watchers.delete(check);
				resolve();
			};
			watchers.add(check);
			check();
		});
	const barrier = () => send("project.list", {});
	const closed = new Promise<void>((resolve) =>
		socket.addEventListener("close", () => resolve(), { once: true }),
	);
	return { socket, frames, send, piEvents, sessionsSeen, waitSettled, barrier, closed };
}

async function runTurn(sessionId: string, witness: Awaited<ReturnType<typeof connect>>) {
	const done = witness.waitSettled(sessionId);
	await promptSession(sessionId, "hi");
	await done;
}

test("a v108 client gets only the sessions it watches; a legacy client still gets them all", async () => {
	const { port, sessionIds } = await startHost(3);
	const [own, , third] = sessionIds;
	if (!own || !third) throw new Error("expected sessions");
	const legacy = await connect(port, "legacy");
	const scoped = await connect(port, "scoped", SESSION_TOPICS_PROTOCOL_VERSION);
	expect((await scoped.send("session.watch", { sessionIds: [own] })).ok).toBe(true);
	expect((await legacy.send("session.watch", { sessionIds: [own] })).ok).toBe(true);

	for (const id of sessionIds) await runTurn(id, legacy);
	await scoped.barrier();

	expect(legacy.sessionsSeen()).toEqual(new Set(sessionIds));
	const settledFor = (client: typeof legacy) =>
		client
			.piEvents()
			.filter(
				(frame) => frame.data?.sessionId === own && frame.data.event?.type === "agent_settled",
			);
	expect(settledFor(legacy)).toHaveLength(1);
	expect(settledFor(scoped)).toHaveLength(1);
	expect(scoped.sessionsSeen()).toEqual(new Set([own]));
	expect(scoped.piEvents().length).toBeGreaterThan(0);
	expect(scoped.frames.filter((frame) => frame.channel === WS_CHANNELS.sessionState).length).toBe(
		legacy.frames.filter((frame) => frame.channel === WS_CHANNELS.sessionState).length,
	);
}, 60_000);

test("unwatch stops delivery", async () => {
	const { port, sessionIds } = await startHost(1);
	const [id] = sessionIds;
	if (!id) throw new Error("expected a session");
	const legacy = await connect(port, "legacy");
	const scoped = await connect(port, "scoped", SESSION_TOPICS_PROTOCOL_VERSION);
	await scoped.send("session.watch", { sessionIds: [id] });
	await runTurn(id, legacy);
	await scoped.barrier();
	const before = scoped.piEvents().length;
	expect(before).toBeGreaterThan(0);

	await scoped.send("session.unwatch", { sessionIds: [id] });
	legacy.frames.length = 0;
	await runTurn(id, legacy);
	await scoped.barrier();

	expect(scoped.piEvents().length).toBe(before);
}, 60_000);

test("a replacing watch drops ids the client no longer wants, also across a reconnect", async () => {
	const { port, sessionIds } = await startHost(2);
	const [kept, dropped] = sessionIds;
	if (!kept || !dropped) throw new Error("expected sessions");
	const legacy = await connect(port, "legacy");
	const first = await connect(port, "page", SESSION_TOPICS_PROTOCOL_VERSION);
	await first.send("session.watch", { sessionIds: [kept, dropped] });
	first.socket.close();
	await first.closed;

	const second = await connect(port, "page", SESSION_TOPICS_PROTOCOL_VERSION);
	expect((await second.send("session.watch", { sessionIds: [kept], replace: true })).ok).toBe(true);
	for (const id of sessionIds) await runTurn(id, legacy);
	await second.barrier();

	expect(second.sessionsSeen()).toEqual(new Set([kept]));
	expect((await second.send("session.watch", { sessionIds: [], replace: "yes" })).ok).toBe(false);
}, 60_000);

test("a reconnect with the same client key keeps its watches without restating them", async () => {
	const { port, sessionIds } = await startHost(1);
	const [id] = sessionIds;
	if (!id) throw new Error("expected a session");
	const legacy = await connect(port, "legacy");
	const first = await connect(port, "page", SESSION_TOPICS_PROTOCOL_VERSION);
	await first.send("session.watch", { sessionIds: [id] });
	first.socket.close();
	await first.closed;

	const second = await connect(port, "page", SESSION_TOPICS_PROTOCOL_VERSION);
	await runTurn(id, legacy);
	await second.barrier();

	expect(second.sessionsSeen()).toEqual(new Set([id]));
}, 60_000);

test("a watch sent just before a transcript read covers events after the snapshot", async () => {
	const { port, sessionIds } = await startHost(1);
	const [id] = sessionIds;
	if (!id) throw new Error("expected a session");
	const legacy = await connect(port, "legacy");
	const scoped = await connect(port, "scoped", SESSION_TOPICS_PROTOCOL_VERSION);
	void scoped.send("session.watch", { sessionIds: [id] });
	const snapshot = await scoped.send("session.getMessages", { sessionId: id, workspaceId: "w1" });
	expect(snapshot.ok).toBe(true);

	await runTurn(id, legacy);
	await scoped.barrier();

	const types = scoped.piEvents().map((frame) => frame.data?.event?.type);
	expect(types).toContain("agent_start");
	expect(types).toContain("agent_settled");
}, 60_000);

test("watch params are validated", async () => {
	const { port } = await startHost(0);
	const scoped = await connect(port, "scoped", SESSION_TOPICS_PROTOCOL_VERSION);
	expect((await scoped.send("session.watch", { sessionIds: "nope" })).ok).toBe(false);
	expect((await scoped.send("session.watch", { sessionIds: ["../x"] })).ok).toBe(false);
	expect((await scoped.send("session.unwatch", { sessionIds: [] })).ok).toBe(true);
}, 60_000);
