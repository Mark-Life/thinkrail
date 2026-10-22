import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanSha, prepareSha, releaseSha, resolveSha, tryLock } from "./checkout";
import type { Artifact } from "./types";

const root = mkdtempSync(join(tmpdir(), "perf-checkout-test-"));
const repo = join(root, "repo");
const previousCache = process.env.THINKRAIL_PERF_CACHE;
process.env.THINKRAIL_PERF_CACHE = join(root, "cache");

afterAll(() => {
	if (previousCache === undefined) delete process.env.THINKRAIL_PERF_CACHE;
	else process.env.THINKRAIL_PERF_CACHE = previousCache;
	rmSync(root, { recursive: true, force: true });
});

function gitIn(...args: string[]) {
	execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

test("a failed rebuild is built again on the next run", async () => {
	execFileSync("git", ["init", "--quiet", repo]);
	mkdirSync(join(repo, "pkg"), { recursive: true });
	writeFileSync(join(repo, "pkg", "package.json"), '{"name":"pkg"}\n');
	const broken = join(root, "broken");
	const builds = join(root, "builds");
	const manifest = {
		name: "fixture",
		private: true,
		workspaces: ["pkg"],
		scripts: { "build:x": `echo x >> ${builds} && test ! -e ${broken}` },
	};
	writeFileSync(join(repo, "package.json"), `${JSON.stringify(manifest)}\n`);
	execFileSync(process.execPath, ["install", "--cwd", repo], { stdio: "ignore" });
	gitIn("add", ".");
	gitIn("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "init");
	const sha = resolveSha(repo, "HEAD");
	const artifact: Artifact = { key: "binary", cwd: ".", command: ["build:x"] };
	const prepare = (rebuild: boolean) =>
		prepareSha({ toolRoot: repo, sha, artifacts: [artifact], rebuild });

	expect((await prepare(false)).failed.size).toBe(0);
	writeFileSync(broken, "");
	expect((await prepare(true)).failed.get("binary")).toBe("binary build failed (exit 1)");
	rmSync(broken);
	expect((await prepare(false)).failed.size).toBe(0);
	expect((await prepare(false)).failed.size).toBe(0);
	expect(readFileSync(builds, "utf8").split("\n").filter(Boolean)).toHaveLength(3);

	const users = join(root, "cache", "locks", `${sha}.users`);
	writeFileSync(join(users, String(process.ppid)), "");
	await expect(prepare(true)).rejects.toThrow("cannot rebuild");
	await expect(cleanSha(sha)).rejects.toThrow("cannot clean");
	rmSync(join(users, String(process.ppid)));
	releaseSha(sha);
	expect(await cleanSha(sha)).toBe(join(root, "cache", "wt", sha));
}, 60_000);

test("a lock is taken with its pid, and a pid-less or dead lock is reclaimed", () => {
	const lock = join(root, "lock");
	expect(tryLock(lock)).toBe(true);
	expect(readFileSync(join(lock, "pid"), "utf8")).toBe(String(process.pid));
	expect(tryLock(lock)).toBe(false);
	expect(existsSync(lock)).toBe(true);
	rmSync(lock, { recursive: true });

	mkdirSync(lock);
	expect(tryLock(lock)).toBe(true);
	rmSync(lock, { recursive: true });

	mkdirSync(lock);
	writeFileSync(join(lock, "pid"), "");
	expect(tryLock(lock)).toBe(false);
	expect(existsSync(lock)).toBe(false);
	expect(tryLock(lock)).toBe(true);
	expect(existsSync(`${lock}.${process.pid}.tmp`)).toBe(false);
});
