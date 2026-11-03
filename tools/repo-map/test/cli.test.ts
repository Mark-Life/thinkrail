import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiHandlers } from "../api";
import { diffGraphs } from "../core/diff";
import type { GraphDiff, RepoGraph } from "../core/types";
import { loadGraph } from "../graphs";
import type { Session } from "../session";
import { createFixtureRepo, type FixtureRepo } from "./fixture";

setDefaultTimeout(120_000);

const CLI = join(import.meta.dir, "..", "cli.ts");

let repo: FixtureRepo;
let session: Session;
let baseSha: string;
let headSha: string;

function runCli(input: { args: string[]; cwd: string; env?: Record<string, string> }) {
	const result = Bun.spawnSync(["bun", CLI, ...input.args], {
		cwd: input.cwd,
		env: { ...process.env, ...input.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function request(path: string) {
	return new Request(`http://127.0.0.1${path}`);
}

beforeAll(() => {
	repo = createFixtureRepo();
	baseSha = repo.commit("base");
	repo.write({
		"packages/server/src/format.ts": `export function formatEcho(text: string) {
	return text.trim().toUpperCase();
}
`,
	});
	headSha = repo.commit("head");
	repo.write({ "packages/server/src/format.ts": "export const dirtyEdit = 1;\n" });
	const base = loadGraph({
		root: repo.root,
		target: { kind: "commit", sha: baseSha },
		refresh: false,
	}).graph;
	const head = loadGraph({ root: repo.root, target: { kind: "worktree" }, refresh: false }).graph;
	session = {
		root: repo.root,
		info: { mode: "diff", repoName: "fixture", title: "t", base: base.ref, head: head.ref },
		head,
		base,
		diff: diffGraphs({ base, head }),
	};
});

afterAll(() => repo.dispose());

describe("api", () => {
	test("serves session, graphs and diff", async () => {
		const api = createApiHandlers(session);
		expect(await api.session().json()).toEqual(session.info);
		const graph: RepoGraph = await api.graph(request("/api/graph?side=base")).json();
		expect(graph.ref).toEqual({ kind: "commit", sha: baseSha });
		const diff: GraphDiff = await api.diff().json();
		expect(diff.changedFiles).toContain("packages/server/src/format.ts");
		expect(api.graph(request("/api/graph?side=nope")).status).toBe(400);
	});

	test("source reads git for a commit and disk for the working tree", async () => {
		const api = createApiHandlers(session);
		const file = "packages/server/src/format.ts";
		const base = await api.source(request(`/api/source?side=base&file=${file}`));
		expect(await base.text()).toContain("text.trim();");
		const head = await api.source(request(`/api/source?side=head&file=${file}`));
		expect(await head.text()).toContain("dirtyEdit");
	});

	test("source rejects paths outside the graph", async () => {
		const api = createApiHandlers(session);
		for (const file of [
			"../../etc/passwd",
			"/etc/passwd",
			".git/config",
			"package.json",
			"packages/server/src/../../../package.json",
		]) {
			const response = await api.source(
				request(`/api/source?side=head&file=${encodeURIComponent(file)}`),
			);
			expect(response.status).toBe(403);
		}
		expect((await api.source(request("/api/source?side=head"))).status).toBe(400);
	});
});

describe("cli", () => {
	test("indexes the repo behind cwd when run by absolute path", () => {
		const output = join(repo.root, "..", `repo-map-cli-${process.pid}.json`);
		const result = runCli({
			args: ["--json", output],
			cwd: join(repo.root, "packages/server/src"),
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("wire methods: 3");
		const graph: RepoGraph = JSON.parse(readFileSync(output, "utf8"));
		rmSync(output);
		expect(graph.ref.kind).toBe("worktree");
		expect(graph.symbols.some((symbol) => symbol.name === "dirtyEdit")).toBe(true);
	});

	test("diff reads refs and honours --cwd", () => {
		const output = join(repo.root, "..", `repo-map-diff-${process.pid}.json`);
		const result = runCli({
			args: ["diff", `${baseSha}..${headSha}`, "--json", output, "--cwd", repo.root],
			cwd: tmpdir(),
		});
		expect(result.exitCode).toBe(0);
		const diff: GraphDiff = JSON.parse(readFileSync(output, "utf8"));
		rmSync(output);
		expect(
			diff.groups.flatMap((group) => group.symbolChanges).map((change) => change.kind),
		).toContain("modified");
	});

	test("prints usage and exits 2 on a bad flag", () => {
		const result = runCli({ args: ["--wat"], cwd: tmpdir() });
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("Unknown flag");
	});

	test("serves over 127.0.0.1 and falls forward from a taken port", async () => {
		const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
		const child = Bun.spawn(
			["bun", CLI, "--no-open", "--port", String(taken.port), "--cwd", repo.root],
			{ stdout: "pipe", stderr: "pipe" },
		);
		try {
			let output = "";
			const decoder = new TextDecoder();
			for await (const chunk of child.stdout) {
				output += decoder.decode(chunk);
				if (output.includes("serving ")) break;
			}
			const url = /serving (\S+)/.exec(output)?.[1];
			expect(url).toBeDefined();
			expect(url).toStartWith("http://127.0.0.1:");
			expect(url).not.toContain(`:${taken.port}/`);
			const session: { mode: string } = await (await fetch(`${url}api/session`)).json();
			expect(session.mode).toBe("map");
			const page = await fetch(String(url));
			expect(page.status).toBe(200);
			expect(await page.text()).toContain("<html");
		} finally {
			child.kill();
			await child.exited;
			taken.stop(true);
		}
	});
});

describe("pr mode", () => {
	test("compares the PR head to its merge-base through gh and a fetched ref", () => {
		const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "repo-map-pr-")));
		const origin = join(sandbox, "acme/widget.git");
		mkdirSync(origin, { recursive: true });
		Bun.spawnSync(["git", "init", "--quiet", "--bare", "--initial-branch=main", origin]);
		const pr = createFixtureRepo();
		try {
			const mergeBase = pr.commit("base");
			pr.git("remote", "add", "origin", origin);
			pr.git("push", "--quiet", "origin", "main");
			pr.git("checkout", "--quiet", "-b", "feature");
			pr.write({
				"packages/server/src/format.ts": `export function formatEcho(text: string) {
	return text.trim().toUpperCase();
}
`,
			});
			const prHead = pr.commit("feature");
			pr.git("push", "--quiet", "origin", "feature:refs/pull/7/head");
			pr.git("checkout", "--quiet", "main");
			pr.write({ "packages/web/src/later.ts": "export const later = 1;\n" });
			const mainTip = pr.commit("later on main");
			pr.git("push", "--quiet", "origin", "main");
			pr.git("reset", "--quiet", "--hard", mergeBase);
			pr.git("branch", "-D", "feature");
			const bin = join(sandbox, "bin");
			mkdirSync(bin);
			writeFileSync(
				join(bin, "gh"),
				`#!/bin/sh\necho '${JSON.stringify({
					title: "Shout echo",
					baseRefName: "main",
					baseRefOid: mainTip,
					headRefOid: prHead,
				})}'\n`,
				{ mode: 0o755 },
			);
			const output = join(sandbox, "pr.json");
			const result = runCli({
				args: ["pr", "7", "--json", output],
				cwd: pr.root,
				env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
			});
			expect(result.stderr).toBe("");
			expect(result.exitCode).toBe(0);
			const diff: GraphDiff = JSON.parse(readFileSync(output, "utf8"));
			expect(diff.changedFiles).toEqual(["packages/server/src/format.ts"]);
		} finally {
			pr.dispose();
			rmSync(sandbox, { recursive: true, force: true });
		}
	});
});
