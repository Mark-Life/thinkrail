import { describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLocalHost, normalizeHost, parseHost, requiredBrowsers, shellQuote } from "./remote";
import type { CompareOptions } from "./types";

const OPTIONS: CompareOptions = {
	suites: ["bundle", "startup"],
	scenarios: null,
	rounds: null,
	startup: ["cli", "server"],
	minRuns: 10,
	maxMinutes: 3,
	threshold: 0,
	cpu: 1,
	browser: "chromium",
	out: "/tmp/out",
	rebuild: false,
};

test("shellQuote survives a real shell", () => {
	const values = ["plain", "it's", "a b", "$HOME", "`id`", "x'\"y"];
	const script = `printf '%s\\n' ${values.map(shellQuote).join(" ")}`;
	expect(execFileSync("sh", ["-c", script], { encoding: "utf8" }).trimEnd().split("\n")).toEqual(
		values,
	);
});

test("normalizeHost drops domains but keeps IPs", () => {
	expect(normalizeHost("Box-A.local")).toBe("box-a");
	expect(normalizeHost("box-b.tail1234.ts.net.")).toBe("box-b");
	expect(normalizeHost("100.64.0.7")).toBe("100.64.0.7");
});

test("isLocalHost matches the alias, its ssh hostname, or local", () => {
	const localName = "Box-A.local";
	expect(isLocalHost({ host: "local", localName, sshHostname: "local" })).toBe(true);
	expect(isLocalHost({ host: "a", localName, sshHostname: "box-a" })).toBe(true);
	expect(isLocalHost({ host: "box-b", localName, sshHostname: "box-b" })).toBe(false);
	expect(isLocalHost({ host: "box-b", localName: "box-b", sshHostname: "box-b" })).toBe(true);
});

test("requiredBrowsers follows the browser suites", () => {
	expect(requiredBrowsers(OPTIONS)).toEqual([]);
	expect(requiredBrowsers({ ...OPTIONS, suites: ["renders"] })).toEqual(["chromium"]);
	expect(
		requiredBrowsers({ ...OPTIONS, suites: ["renders", "waterfall"], browser: "webkit" }),
	).toEqual(["chromium", "webkit"]);
});

test("parseHost accepts ssh aliases and rejects option-like values", () => {
	expect(parseHost("box-a")).toBe("box-a");
	expect(parseHost("user@box.example.com")).toBe("user@box.example.com");
	for (const bad of [undefined, "", "-oProxyCommand=x", "a b", "a;b"]) {
		expect(() => parseHost(bad)).toThrow("--host needs");
	}
});

describe.skipIf(process.platform === "win32")("remoteRun.sh", () => {
	const source = readFileSync(join(import.meta.dir, "remoteRun.sh"), "utf8");
	const dir = mkdtempSync(join(tmpdir(), "perf-remote-run-"));

	const run = (pidFile: string, command: string[]) => {
		const child = spawn("bash", ["-c", source, "perf-run", pidFile, ...command], {
			stdio: ["pipe", "ignore", "ignore"],
		});
		const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
		return { child, exited };
	};

	test("passes the command's exit status through", async () => {
		const { child, exited } = run(join(dir, "ok", "compare.pid"), ["sh", "-c", "exit 7"]);
		expect(await exited).toBe(7);
		child.stdin.end();
	});

	test("kills the command's process group when stdin closes", async () => {
		const pidFile = join(dir, "eof", "compare.pid");
		const { child, exited } = run(pidFile, ["sleep", "41"]);
		for (let attempt = 0; attempt < 200 && !existsSync(pidFile); attempt += 1) await Bun.sleep(10);
		const pid = Number(readFileSync(pidFile, "utf8"));
		expect(pid).toBeGreaterThan(0);
		child.stdin.end();
		await exited;
		expect(() => process.kill(pid, 0)).toThrow();
	});
});
