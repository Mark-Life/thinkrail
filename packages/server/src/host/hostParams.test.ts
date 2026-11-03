import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type WireModel, WS_CHANNELS } from "@thinkrail/contracts";
import { testWorkspaceId } from "@thinkrail/contracts/test-ids";
import { configurePiRuntime, configurePiRuntimeFactory } from "../agent";
import { resetAnalyticsForTests, shutdownAnalytics } from "../analytics";
import { resetJbcentralStateForTests } from "../auth";
import { resetConfigCache, setSettingsPublisher } from "../settings";
import { handleRequest } from "./handlers";
import { createServer, type RunningServer } from "./server";

const CTX = { clientKey: "host-params-test" };
const SAVED_ENV = {
	THINKRAIL_DATA_DIR: process.env.THINKRAIL_DATA_DIR,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	PI_OFFLINE: process.env.PI_OFFLINE,
};
const MODEL: WireModel = {
	id: "m",
	name: "M",
	provider: "p",
	contextWindow: 1000,
	reasoning: false,
	thinkingLevels: ["off"],
};

let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "thinkrail-host-params-"));
	process.env.THINKRAIL_DATA_DIR = dataDir;
	process.env.PI_CODING_AGENT_DIR = join(dataDir, "pi");
	process.env.PI_OFFLINE = "1";
	resetConfigCache();
});

afterEach(() => {
	setSettingsPublisher(null);
	resetConfigCache();
	resetAnalyticsForTests();
	rmSync(dataDir, { recursive: true, force: true });
	for (const [key, value] of Object.entries(SAVED_ENV)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function configPath() {
	return join(dataDir, "config.json");
}

function preset(center: unknown) {
	const side = { visible: false, width: 0.2, groups: [] };
	return {
		id: "preset",
		name: "Preset",
		center,
		left: side,
		right: side,
		bottom: { visible: false, height: 0.2, alignment: "center", groups: [] },
	};
}

function split(id: string, children: [unknown, unknown]) {
	return { kind: "split", id, direction: "horizontal", weights: [0.5, 0.5], children };
}

test("an unknown method keeps its plain reply and never reaches the params check", async () => {
	const refusal = handleRequest("no.such.method", { any: "params" }, CTX);
	await expect(refusal).rejects.toThrow("Unknown method: no.such.method");
	await expect(refusal).rejects.not.toHaveProperty("code");
});

test.each([
	["a non-object config", "theme"],
	["a non-string theme", { theme: 7 }],
	["a preset center that is not an object", { customLayoutPresets: [preset(7)] }],
])("settings.update refuses %s at dispatch, before disk or broadcast", async (_label, config) => {
	const published: unknown[] = [];
	setSettingsPublisher((next) => published.push(next));
	const refusal = handleRequest("settings.update", { config }, CTX);
	await expect(refusal).rejects.toMatchObject({ code: "INVALID_PARAMS" });
	expect(existsSync(configPath())).toBe(false);
	expect(published).toEqual([]);
});

test("settings.update never persists an undeclared field", async () => {
	await expect(
		handleRequest("settings.update", { config: { theme: "a", futureSetting: 1 } }, CTX),
	).rejects.toThrow("Unknown setting: futureSetting");
	expect(existsSync(configPath())).toBe(false);

	const next = await handleRequest(
		"settings.update",
		{ config: { theme: "a", recentModels: "junk", layout: 1 }, extra: true },
		CTX,
	);
	const stored = JSON.parse(readFileSync(configPath(), "utf8"));
	expect(stored.theme).toBe("a");
	expect(stored.recentModels).toEqual(DEFAULT_CONFIG.recentModels);
	for (const value of [stored, next]) {
		expect(value).not.toHaveProperty("layout");
		expect(value).not.toHaveProperty("extra");
	}
});

test("settings.update takes a nested layout preset and clears overrides with null", async () => {
	const center = split("root", [
		{ kind: "group", id: "a" },
		split("inner", [
			{ kind: "group", id: "b" },
			{ kind: "group", id: "c" },
		]),
	]);
	const next = await handleRequest(
		"settings.update",
		{
			config: { customLayoutPresets: [preset(center)], defaultModel: MODEL, defaultEffort: "low" },
		},
		CTX,
	);
	expect(next).toMatchObject({ customLayoutPresets: [{ center }], defaultModel: MODEL });
	const cleared = await handleRequest(
		"settings.update",
		{ config: { defaultModel: null, defaultEffort: null } },
		CTX,
	);
	expect(cleared).not.toHaveProperty("defaultModel");
	expect(cleared).not.toHaveProperty("defaultEffort");
});

test("environment.update refuses a malformed record at dispatch", async () => {
	for (const environment of [null, { vars: [{ name: 1, value: "x" }] }, { vars: "x" }]) {
		const refusal = handleRequest("environment.update", { environment }, CTX);
		await expect(refusal).rejects.toMatchObject({ code: "INVALID_PARAMS" });
	}
	expect(existsSync(join(dataDir, "environment.json"))).toBe(false);
});

test("a client report with the wrong shape never reaches the sanitizer", async () => {
	for (const report of [undefined, { kind: "bogus", type: "T" }, { kind: "window", type: 42 }]) {
		const refusal = handleRequest("client.reportError", report, CTX);
		await expect(refusal).rejects.toMatchObject({ code: "INVALID_PARAMS" });
	}
	expect(await handleRequest("client.reportError", { kind: "window", type: "T" }, CTX)).toEqual({
		ok: true,
	});
});

async function withHostSocket(
	analytics: NonNullable<Parameters<typeof createServer>[0]>["analytics"],
	run: (socket: WebSocket, reply: (id: string) => Promise<unknown>) => Promise<void>,
) {
	let server: RunningServer | undefined;
	let socket: WebSocket | undefined;
	try {
		server = await createServer({
			port: 0,
			host: "127.0.0.1",
			appVersion: "0.0.0-dev",
			...(analytics ? { analytics } : {}),
		});
		socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?client=host-params`);
		const welcomed = Promise.withResolvers<void>();
		const replies = new Map<string, (message: unknown) => void>();
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data));
			if (message.channel === WS_CHANNELS.serverWelcome) welcomed.resolve();
			if (typeof message.id === "string") replies.get(message.id)?.(message);
		});
		await welcomed.promise;
		await run(
			socket,
			(id) =>
				new Promise((resolve) => {
					replies.set(id, resolve);
				}),
		);
	} finally {
		socket?.close();
		await server?.shutdown();
		await resetJbcentralStateForTests();
		configurePiRuntimeFactory();
		configurePiRuntime(null);
	}
}

test("a refused client report raises no error report; another refused method does", async () => {
	const batches: string[] = [];
	const fetchImpl = Object.assign(
		async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			batches.push(String(init?.body));
			return new Response("{}", { status: 200 });
		},
		{ preconnect: fetch.preconnect },
	);
	await withHostSocket(
		{ posthogApiKey: "phc_test", channel: "dev", build: "source", env: {}, fetchImpl },
		async (socket, reply) => {
			const refusedReport = reply("report");
			socket.send(
				JSON.stringify({ id: "report", method: "client.reportError", params: { kind: "bogus" } }),
			);
			expect(await refusedReport).toMatchObject({ errorCode: "INVALID_PARAMS" });

			const refusedOpen = reply("open");
			socket.send(JSON.stringify({ id: "open", method: "project.open", params: { path: 7 } }));
			expect(await refusedOpen).toMatchObject({ errorCode: "INVALID_PARAMS" });
			await shutdownAnalytics();
			expect(batches.filter((body) => body.includes("project.open"))).not.toEqual([]);
			expect(batches.filter((body) => body.includes("client.reportError"))).toEqual([]);
		},
	);
});

test("params too deep to fingerprint get a coded reply, and the host keeps serving", async () => {
	const depth = 200_000;
	const deepFrame = `{"id":"deep","method":"session.respondToTool","params":${"[".repeat(depth)}${"]".repeat(depth)}}`;
	await withHostSocket(undefined, async (socket, reply) => {
		const refused = reply("deep");
		socket.send(deepFrame);
		expect(await refused).toMatchObject({ id: "deep", ok: false, errorCode: "INVALID_PARAMS" });

		const refusedAgain = reply("deep");
		socket.send(deepFrame);
		expect(await refusedAgain).toMatchObject({ id: "deep", errorCode: "INVALID_PARAMS" });

		const reused = reply("deep");
		socket.send(JSON.stringify({ id: "deep", method: "project.open", params: { path: 7 } }));
		expect(await reused).toMatchObject({
			id: "deep",
			errorCode: "INVALID_PARAMS",
			error: expect.stringContaining("Invalid project.open"),
		});

		const served = reply("after");
		socket.send(JSON.stringify({ id: "after", method: "settings.update", params: { config: {} } }));
		expect(await served).toMatchObject({ id: "after", ok: true });
	});
});

function nestedCenter(depth: number): unknown {
	let node: unknown = { kind: "group", id: 7 };
	for (let level = depth; level > 0; level -= 1) {
		node = split(`s${level}`, [{ kind: "group", id: `g${level}` }, node]);
	}
	return node;
}

test("a malformed preset center is refused by its own guard, before disk", async () => {
	const config = { customLayoutPresets: [preset(split("a", [{ id: "b" }, 1]))] };
	await expect(handleRequest("settings.update", { config }, CTX)).rejects.toThrow(
		"Malformed layout preset center",
	);
	expect(existsSync(configPath())).toBe(false);
});

test("a preset center too deep and malformed at the bottom stops at the depth guard", async () => {
	const config = { customLayoutPresets: [preset(nestedCenter(4000))] };
	expect(JSON.stringify(config).length).toBeGreaterThan(400 * 1024);
	expect(JSON.stringify(config).length).toBeLessThan(512 * 1024);
	await expect(handleRequest("settings.update", { config }, CTX)).rejects.toThrow(
		"Layout preset center is too deep",
	);
	expect(existsSync(configPath())).toBe(false);
});

test("oversized refused params never build a per-element report", async () => {
	const commentIds = Array.from({ length: 20_000 }, (_, index) => index);
	const params = { workspaceId: testWorkspaceId("w"), commentIds };
	expect(JSON.stringify(params).length).toBeGreaterThan(64 * 1024);
	const refusal = handleRequest("review.sendBatch", params, CTX);
	await expect(refusal).rejects.toMatchObject({
		code: "INVALID_PARAMS",
		message: "Invalid review.sendBatch",
	});
});

test("params too deep to measure are refused with the same coded error", async () => {
	const depth = 200_000;
	const workspaceId = JSON.parse(`${"[".repeat(depth)}${"]".repeat(depth)}`);
	const refusal = handleRequest("review.sendBatch", { workspaceId, commentIds: [] }, CTX);
	await expect(refusal).rejects.toMatchObject({
		code: "INVALID_PARAMS",
		message: "Invalid review.sendBatch",
	});
});

test("small refused params keep their reasons, and a missing params object is one of them", async () => {
	const refusal = handleRequest(
		"review.sendBatch",
		{ workspaceId: testWorkspaceId("w"), commentIds: [1] },
		CTX,
	);
	await expect(refusal).rejects.toThrow(/^Invalid review\.sendBatch: /);
	const missing = handleRequest("review.sendBatch", undefined, CTX);
	await expect(missing).rejects.toThrow(/^Invalid review\.sendBatch: /);
});
