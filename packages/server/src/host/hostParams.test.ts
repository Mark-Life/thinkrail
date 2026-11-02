import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type WireModel, WS_CHANNELS } from "@thinkrail/contracts";
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
	["a preset leaf inside a split", { customLayoutPresets: [preset(split("a", [{ id: "b" }, 1]))] }],
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

test("speech.install refuses a model outside the union before an install starts", async () => {
	for (const model of ["tiny", 1, undefined]) {
		const refusal = handleRequest("speech.install", { model }, CTX);
		await expect(refusal).rejects.toMatchObject({ code: "INVALID_PARAMS" });
	}
	expect(existsSync(join(dataDir, "speech"))).toBe(false);
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

test("a refused client report raises no error report; another refused method does", async () => {
	const batches: string[] = [];
	const fetchImpl = Object.assign(
		async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			batches.push(String(init?.body));
			return new Response("{}", { status: 200 });
		},
		{ preconnect: fetch.preconnect },
	);
	let server: RunningServer | undefined;
	const sockets: WebSocket[] = [];
	try {
		server = await createServer({
			port: 0,
			host: "127.0.0.1",
			appVersion: "0.0.0-dev",
			analytics: { posthogApiKey: "phc_test", channel: "dev", build: "source", env: {}, fetchImpl },
		});
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?client=host-params`);
		sockets.push(socket);
		const welcomed = Promise.withResolvers<void>();
		const replies = new Map<string, (message: unknown) => void>();
		const reply = (id: string) =>
			new Promise<unknown>((resolve) => {
				replies.set(id, resolve);
			});
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data));
			if (message.channel === WS_CHANNELS.serverWelcome) welcomed.resolve();
			if (typeof message.id === "string") replies.get(message.id)?.(message);
		});
		await welcomed.promise;

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
	} finally {
		for (const socket of sockets) socket.close();
		await server?.shutdown();
		await resetJbcentralStateForTests();
		configurePiRuntimeFactory();
		configurePiRuntime(null);
	}
});
