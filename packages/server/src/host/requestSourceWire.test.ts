import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_FONT_UPLOAD_HEADER, WS_CHANNELS } from "@thinkrail/contracts";
import { configurePiRuntime, configurePiRuntimeFactory } from "../agent";
import { resetAnalyticsForTests } from "../analytics";
import { resetJbcentralStateForTests } from "../auth";
import { resetConfigCache } from "../settings";
import { createServer, type RunningServer } from "./server";

const ENV = [
	"THINKRAIL_DATA_DIR",
	"PI_CODING_AGENT_DIR",
	"PI_OFFLINE",
	"THINKRAIL_ALLOWED_HOSTS",
] as const;
const saved = new Map(ENV.map((key) => [key, process.env[key]]));
let directory: string;
let server: RunningServer;
let base: string;

async function resetHostState(): Promise<void> {
	resetConfigCache();
	await resetJbcentralStateForTests();
	configurePiRuntime(null);
	configurePiRuntimeFactory();
}

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "thinkrail-request-source-"));
	process.env.THINKRAIL_DATA_DIR = join(directory, "data");
	process.env.PI_CODING_AGENT_DIR = join(directory, "pi");
	process.env.PI_OFFLINE = "1";
	process.env.THINKRAIL_ALLOWED_HOSTS = "env.example, .proxy.example";
	await resetHostState();
	server = await createServer({
		port: 0,
		host: "127.0.0.1",
		allowedHosts: ["option.example"],
		analytics: { mute: true },
	});
	base = `127.0.0.1:${server.port}`;
});

afterAll(async () => {
	await server.shutdown();
	resetAnalyticsForTests();
	await resetHostState();
	rmSync(directory, { recursive: true, force: true });
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(`http://${base}${path}`, { headers });
}

function rawRequest(text: string): Promise<string> {
	const response = Promise.withResolvers<string>();
	const socket = connect(server.port, "127.0.0.1", () => socket.write(text));
	let received = "";
	socket.on("data", (chunk) => {
		received += chunk.toString("latin1");
		const upgraded = received.startsWith("HTTP/1.1 101");
		if (received.includes(upgraded ? WS_CHANNELS.serverWelcome : "\r\n\r\n")) socket.destroy();
	});
	socket.on("close", () => response.resolve(received));
	socket.on("error", response.reject);
	return response.promise;
}

function upgrade(route: string, headers: Record<string, string> = {}): Promise<string> {
	const lines = Object.entries({
		Host: base,
		...headers,
		Connection: "Upgrade",
		Upgrade: "websocket",
		"Sec-WebSocket-Version": "13",
		"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
	}).map(([name, value]) => `${name}: ${value}`);
	return rawRequest([`GET ${route} HTTP/1.1`, ...lines, "", ""].join("\r\n"));
}

test("/ws opens for a non-browser client and for the host's own origin", async () => {
	const socket = new WebSocket(`ws://${base}/ws`);
	const welcomed = Promise.withResolvers<boolean>();
	socket.addEventListener("message", (event) => {
		const frame = JSON.parse(String(event.data)) as { channel?: string };
		if (frame.channel === WS_CHANNELS.serverWelcome) welcomed.resolve(true);
	});
	socket.addEventListener("close", () => welcomed.resolve(false));
	expect(await welcomed.promise.finally(() => socket.close())).toBe(true);

	const own = await upgrade("/ws", { Origin: `http://${base}` });
	expect(own).toStartWith("HTTP/1.1 101");
	expect(own).toContain(WS_CHANNELS.serverWelcome);
});

test("/ws refuses another site, a sandboxed frame and a rebinding name", async () => {
	for (const headers of [
		{ Origin: "https://evil.example" },
		{ Origin: "null" },
		{ Origin: "" },
		{ Origin: `http://localhost:${server.port}` },
		{ Host: "evil.example:1", Origin: "http://evil.example:1" },
	]) {
		expect(await upgrade("/ws", headers)).toStartWith("HTTP/1.1 403");
	}
});

test("a loopback bind refuses the names only a wider bind admits", async () => {
	for (const name of ["x.local", "x.ts.net:1", "studio:1"]) {
		expect((await get("/health", { Host: name })).status).toBe(403);
	}
});

test("a bind on every interface admits the names other devices use", async () => {
	const wide = await createServer({ port: 0, host: "0.0.0.0", analytics: { mute: true } });
	try {
		const statusFor = async (name: string) =>
			(await fetch(`http://127.0.0.1:${wide.port}/health`, { headers: { Host: name } })).status;
		expect(await statusFor("studio.tail1234.ts.net")).toBe(200);
		expect(await statusFor("studio.local")).toBe(200);
		expect(await statusFor("studio")).toBe(200);
		expect(await statusFor("evil.example")).toBe(403);
	} finally {
		await wide.shutdown();
	}
});

test("a refusal is plain text that says why", async () => {
	const origin = await get("/ws", { Origin: "https://evil.example" });
	expect(origin.status).toBe(403);
	expect(origin.headers.get("Content-Type")).toStartWith("text/plain");
	expect(origin.headers.get("X-Content-Type-Options")).toBe("nosniff");
	expect(await origin.text()).toContain(`Origin evil.example does not match Host ${base}`);

	const host = await get("/health", { Host: "evil.example:1" });
	expect(host.status).toBe(403);
	expect(await host.text()).toContain("--allowed-host evil.example");
});

test("/speech refuses another site before it reads the protocol", async () => {
	const refused = await get("/speech", { Origin: "https://evil.example" });
	expect(refused.status).toBe(403);
	expect(await upgrade("/speech", { Origin: "null" })).toStartWith("HTTP/1.1 403");
	const own = await get("/speech", { Origin: `http://${base}` });
	expect(own.status).toBe(400);
	expect(await own.text()).toBe("speech needs a newer client");
});

test("/files, /blob and /fonts refuse another site and answer everyone else", async () => {
	for (const path of ["/files/none/a.png", "/blob/none/0/a.png", "/fonts/none.ttf"]) {
		expect((await get(path, { Origin: "https://evil.example" })).status).toBe(403);
		expect((await get(path, { Origin: "null" })).status).toBe(403);
		expect((await get(path)).status).toBe(404);
		expect((await get(path, { Origin: `http://${base}` })).status).toBe(404);
	}
});

test("a cross-origin font upload and its preflight are refused before the route", async () => {
	const preflight = await fetch(`http://${base}/fonts/x.ttf`, {
		method: "OPTIONS",
		headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "PUT" },
	});
	expect(preflight.status).toBe(403);
	expect(await preflight.text()).toContain("refused a request from another site");
	const upload = await fetch(`http://${base}/fonts/x.ttf`, {
		method: "PUT",
		headers: {
			Origin: "https://evil.example",
			[USER_FONT_UPLOAD_HEADER.name]: USER_FONT_UPLOAD_HEADER.value,
		},
		body: "x",
	});
	expect(upload.status).toBe(403);
	expect(await upload.text()).toContain("refused a request from another site");
});

test("names from the option and from THINKRAIL_ALLOWED_HOSTS are admitted", async () => {
	for (const name of ["option.example", "env.example", "tunnel.proxy.example"]) {
		const response = await get("/health", { Host: name, Origin: `https://${name}` });
		expect(response.status).toBe(200);
	}
	expect((await get("/health", { Host: "other.example" })).status).toBe(403);
});

test("a request with no usable Host is 400, not a crash", async () => {
	expect(await rawRequest("GET /health HTTP/1.0\r\n\r\n")).toStartWith("HTTP/1.1 400");
	expect(
		await rawRequest(
			"GET /health HTTP/1.1\r\nHost: localhost@evil.example\r\nConnection: close\r\n\r\n",
		),
	).toStartWith("HTTP/1.1 400");
	expect(
		await rawRequest(
			"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n",
		),
	).toStartWith("HTTP/1.1 400");
	expect((await get("/health")).status).toBe(200);
});

test("an invalid allowed host stops the boot", async () => {
	await expect(createServer({ port: 0, allowedHosts: ["a b"] })).rejects.toThrow(
		"Invalid allowed host: a b",
	);
});
