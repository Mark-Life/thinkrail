import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, timeToExit, timeToReady } from "./startupProcess";
import { startupKinds } from "./suiteStartup";

const cwd = mkdtempSync(join(tmpdir(), "perf-startup-test-"));
const env = { PATH: process.env.PATH ?? "" };

function bun(script: string) {
	return { cwd, env, command: [process.execPath, "-e", script] };
}

describe("startup process timing", () => {
	test("times a process to a clean exit", async () => {
		const elapsed = await timeToExit(bun("console.log('1.2.3')"), 10_000);
		expect(elapsed).toBeGreaterThan(0);
	});

	test("rejects a failing or silent process", async () => {
		await expect(timeToExit(bun("process.exit(3)"), 10_000)).rejects.toThrow("exit 3");
		await expect(timeToExit(bun("process.exit(0)"), 10_000)).rejects.toThrow("printed nothing");
	});

	test("times the ready line and /health of a real server, then stops it", async () => {
		const port = await freePort();
		const script = `Bun.serve({ port: ${port}, hostname: "127.0.0.1", fetch: () => new Response("ok") }); console.log("thinkrail → http://127.0.0.1:${port}");`;
		const times = await timeToReady(
			bun(script),
			{ stdout: /thinkrail → http:\/\/[^\s:]+:(\d+)/, health: port },
			10_000,
		);
		expect(times.stdout).toBeGreaterThan(0);
		expect(times.health).toBeGreaterThan(0);
		const stopped = await fetch(`http://127.0.0.1:${port}/health`).then(
			() => false,
			() => true,
		);
		expect(stopped).toBe(true);
	});

	test("fails when the process exits before it is ready", async () => {
		await expect(timeToReady(bun("process.exit(0)"), { health: 1 }, 10_000)).rejects.toThrow(
			"exited before ready",
		);
	});
});

describe("startupKinds", () => {
	test("keeps known kinds and rejects unknown ones", () => {
		expect(startupKinds({ startup: ["cli", "server"] })).toEqual(["cli", "server"]);
		expect(() => startupKinds({ startup: ["cli", "electron"] })).toThrow("unknown electron");
	});
});
