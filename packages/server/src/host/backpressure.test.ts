import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION, WS_CHANNELS } from "@thinkrail/contracts";
import {
	configurePiRuntime,
	configurePiRuntimeFactory,
	createSession,
	setSessionManagerFactory,
	setSessionPublisher,
	toWireModel,
} from "../agent";
import { resetAnalyticsForTests } from "../analytics";
import { saveWorkspaces } from "../persistence";
import { resetConfigCache } from "../settings";
import { createServer, type RunningServer } from "./server";

const saved = {
	THINKRAIL_DATA_DIR: process.env.THINKRAIL_DATA_DIR,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	PI_OFFLINE: process.env.PI_OFFLINE,
};
let directory: string;
let server: RunningServer | undefined;
const sockets: WebSocket[] = [];

function pngBase64(base64Length: number): string {
	const bytes = Buffer.alloc(Math.floor((base64Length * 3) / 4), 0x5a);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(bytes);
	bytes.write("IHDR", 12, "ascii");
	bytes.writeUInt32BE(1000, 16);
	bytes.writeUInt32BE(1000, 20);
	return bytes.toString("base64");
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "thinkrail-backpressure-"));
	process.env.THINKRAIL_DATA_DIR = join(directory, "data");
	process.env.PI_CODING_AGENT_DIR = join(directory, "pi");
	process.env.PI_OFFLINE = "1";
	const repo = join(directory, "repo");
	mkdirSync(repo);
	writeFileSync(join(repo, "README.md"), "# repo\n");
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
	setSessionManagerFactory((cwd) => SessionManager.inMemory(cwd));
});

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.close();
	await server?.shutdown();
	server = undefined;
	setSessionPublisher(() => {});
	setSessionManagerFactory((cwd) => SessionManager.create(cwd));
	resetAnalyticsForTests();
	resetConfigCache();
	configurePiRuntimeFactory();
	configurePiRuntime(null);
	rmSync(directory, { recursive: true, force: true });
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

test("every client receives agent_settled after a burst of image-carrying events past 16 MiB", async () => {
	const model = {
		id: "burst",
		name: "Burst",
		reasoning: false,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 4096,
	};
	const faux = createFauxCore({
		provider: "burst",
		api: "burst",
		models: [model],
		tokensPerSecond: 1_000_000,
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerProvider("burst", {
		api: faux.api,
		baseUrl: "http://faux.local",
		apiKey: "faux",
		streamSimple: faux.streamSimple,
		models: [{ ...model, api: faux.api }],
	});
	configurePiRuntime(null);
	configurePiRuntimeFactory(async () => runtime);
	server = await createServer({ port: 0, analytics: { mute: true } });
	const { sessionId } = await createSession({
		cwd: join(directory, "repo"),
		workspaceId: "w1",
		model: toWireModel(faux.getModel()),
	});

	const connect = async (client: string) => {
		const socket = new WebSocket(
			`ws://localhost:${server?.port}/ws?client=${client}&protocol=${PROTOCOL_VERSION}`,
		);
		sockets.push(socket);
		const welcomed = Promise.withResolvers<void>();
		const settled = Promise.withResolvers<"settled">();
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as {
				channel?: string;
				data?: { sessionId?: string; event?: { type?: string } };
			};
			if (message.channel === WS_CHANNELS.serverWelcome) welcomed.resolve();
			if (
				message.channel === WS_CHANNELS.piEvent &&
				message.data?.sessionId === sessionId &&
				message.data.event?.type === "agent_settled"
			)
				settled.resolve("settled");
		});
		await welcomed.promise;
		return { socket, settled: settled.promise };
	};
	const sender = await connect("sender");
	const listener = await connect("listener");

	const images = Array.from({ length: 3 }, () => ({
		type: "image" as const,
		data: pngBase64(4 * 1024 * 1024),
		mimeType: "image/png",
	}));
	sender.socket.send(
		JSON.stringify({
			id: "prompt-1",
			method: "session.prompt",
			params: { sessionId, text: "look", images },
		}),
	);

	const outcome = (settled: Promise<"settled">) =>
		Promise.race([settled, Bun.sleep(10_000).then(() => "missed" as const)]);
	expect(await Promise.all([outcome(sender.settled), outcome(listener.settled)])).toEqual([
		"settled",
		"settled",
	]);
}, 30_000);
