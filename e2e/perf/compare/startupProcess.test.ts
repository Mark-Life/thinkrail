import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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

function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(process.platform === "win32")("startup process interruption", () => {
	test("SIGTERM to the tool kills a live startup child", async () => {
		const marker = join(cwd, `pid-${process.pid}`);
		const child = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
		const launch = { cwd, env, command: [process.execPath, "-e", child] };
		const module = JSON.stringify(join(import.meta.dir, "startupProcess.ts"));
		const driver = `const { timeToReady } = await import(${module}); await timeToReady(${JSON.stringify(launch)}, { health: 1 }, 60_000);`;
		const tool = spawn(process.execPath, ["-e", driver], { cwd: import.meta.dir, stdio: "ignore" });
		const exited = new Promise<number | null>((resolve) => tool.once("close", resolve));
		let childPid = 0;
		for (let attempt = 0; attempt < 200 && childPid === 0; attempt += 1) {
			await Bun.sleep(25);
			childPid = existsSync(marker) ? Number(readFileSync(marker, "utf8")) || 0 : 0;
		}
		expect(childPid).toBeGreaterThan(0);
		tool.kill("SIGTERM");
		expect(await exited).toBe(143);
		for (let attempt = 0; attempt < 40 && alive(childPid); attempt += 1) await Bun.sleep(25);
		expect(alive(childPid)).toBe(false);
	});
});

describe("startupKinds", () => {
	test("keeps known kinds and rejects unknown ones", () => {
		expect(startupKinds({ startup: ["cli", "server"] })).toEqual(["cli", "server"]);
		expect(() => startupKinds({ startup: ["cli", "electron"] })).toThrow("unknown electron");
	});
});
