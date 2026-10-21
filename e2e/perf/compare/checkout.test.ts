import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSha, resolveSha } from "./checkout";
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
	writeFileSync(
		join(repo, "package.json"),
		'{"name":"fixture","private":true,"workspaces":["pkg"]}\n',
	);
	execFileSync(process.execPath, ["install", "--cwd", repo], { stdio: "ignore" });
	gitIn("add", ".");
	gitIn("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "init");
	const sha = resolveSha(repo, "HEAD");
	let builds = 0;
	let broken = false;
	const artifact: Artifact = {
		key: "binary",
		inputs: ["x"],
		build: async () => {
			builds += 1;
			if (broken) throw new Error("build broke");
		},
	};
	const prepare = (rebuild: boolean) =>
		prepareSha({ toolRoot: repo, sha, artifacts: [artifact], rebuild });

	expect((await prepare(false)).failed.size).toBe(0);
	broken = true;
	expect((await prepare(true)).failed.get("binary")).toBe("build broke");
	broken = false;
	expect((await prepare(false)).failed.size).toBe(0);
	expect(builds).toBe(3);
}, 60_000);
