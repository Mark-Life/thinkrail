import { basename } from "node:path";
import type { Command, CommonFlags } from "./args";
import { diffGraphs } from "./core/diff";
import type { GraphDiff, RepoGraph, SessionInfo } from "./core/types";
import {
	changedPaths,
	defaultBranchRef,
	dirtyFiles,
	git,
	mergeBase,
	repoRoot,
	resolveCommit,
	tryGit,
} from "./git";
import { type GraphTarget, loadGraph } from "./graphs";
import { isIndexedSource } from "./indexer/program";

export interface Session {
	root: string;
	info: SessionInfo;
	head: RepoGraph;
	base?: RepoGraph;
	diff?: GraphDiff;
}

type CommitTarget = Extract<GraphTarget, { kind: "commit" }>;

interface PullRequestView {
	title: string;
	baseRefName: string;
	baseRefOid: string;
	headRefOid: string;
}

function commitTarget(root: string, ref: string) {
	const target: CommitTarget = { kind: "commit", sha: resolveCommit({ root, ref }) };
	return target;
}

export function repoFromRemoteUrl(url: string) {
	const match = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
	return match ? `${match[1]}/${match[2]}` : undefined;
}

function originRepo(root: string) {
	const url = tryGit({ cwd: root, args: ["remote", "get-url", "origin"] });
	return url ? repoFromRemoteUrl(url) : undefined;
}

function viewPullRequest(input: { root: string; repo: string; number: number }) {
	const result = Bun.spawnSync(
		[
			"gh",
			"pr",
			"view",
			String(input.number),
			"--repo",
			input.repo,
			"--json",
			"title,baseRefName,baseRefOid,headRefOid",
		],
		{ cwd: input.root, stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) {
		throw new Error(`gh pr view failed: ${result.stderr.toString().trim()}`);
	}
	const view: PullRequestView = JSON.parse(result.stdout.toString());
	return view;
}

function loadSide(input: { root: string; target: GraphTarget; refresh: boolean; side: string }) {
	const started = performance.now();
	const { graph, cached } = loadGraph(input);
	const seconds = ((performance.now() - started) / 1000).toFixed(1);
	console.log(`${input.side}: ${cached ? "cache hit" : "indexed"} in ${seconds}s`);
	return graph;
}

function nonCodeChanges(input: { root: string; base: string; head?: string }) {
	const changed = changedPaths(input);
	const dirty = input.head ? [] : dirtyFiles(input.root);
	return [...new Set([...changed, ...dirty])].filter((path) => !isIndexedSource(path));
}

function buildDiffSession(input: {
	root: string;
	title: string;
	base: CommitTarget;
	head: GraphTarget;
	refresh: boolean;
}): Session {
	const { root, title, base, head, refresh } = input;
	const baseGraph = loadSide({ root, target: base, refresh, side: "base" });
	Bun.gc(true);
	const headGraph = loadSide({ root, target: head, refresh, side: "head" });
	const headSha = head.kind === "commit" ? head.sha : undefined;
	const diff = diffGraphs({
		base: baseGraph,
		head: headGraph,
		nonCodeFiles: nonCodeChanges({
			root,
			base: base.sha,
			...(headSha ? { head: headSha } : {}),
		}),
	});
	const info: SessionInfo = {
		mode: "diff",
		repoName: basename(root),
		title,
		base: baseGraph.ref,
		head: headGraph.ref,
	};
	return { root, info, head: headGraph, base: baseGraph, diff };
}

function buildPrSession(input: {
	root: string;
	number: number;
	repo?: string;
	refresh: boolean;
}): Session {
	const { root, number, refresh } = input;
	const origin = originRepo(root);
	const repo = input.repo ?? origin;
	if (!repo) throw new Error("Cannot read the repo from remote origin. Pass --repo owner/name.");
	const view = viewPullRequest({ root, repo, number });
	const remote = repo === origin ? "origin" : `https://github.com/${repo}.git`;
	git({
		cwd: root,
		args: [
			"fetch",
			"--quiet",
			"--no-tags",
			remote,
			`refs/pull/${number}/head`,
			`refs/heads/${view.baseRefName}`,
		],
	});
	const head = view.headRefOid;
	const base = mergeBase({ root, a: view.baseRefOid, b: head });
	return buildDiffSession({
		root,
		title: `#${number} ${view.title}`,
		base: { kind: "commit", sha: base },
		head: { kind: "commit", sha: head },
		refresh,
	});
}

export function buildSession(input: {
	command: Exclude<Command, { mode: "help" }>;
	flags: CommonFlags;
	cwd: string;
}): Session {
	const { command, flags } = input;
	const root = repoRoot(flags.cwd ?? input.cwd);
	const refresh = flags.refresh;
	if (command.mode === "map") {
		const head = loadSide({ root, target: { kind: "worktree" }, refresh, side: "head" });
		const info: SessionInfo = { mode: "map", repoName: basename(root), head: head.ref };
		return { root, info, head };
	}
	if (command.mode === "pr") {
		return buildPrSession({
			root,
			number: command.number,
			refresh,
			...(command.repo ? { repo: command.repo } : {}),
		});
	}
	const headRef = command.head;
	const headTarget: GraphTarget = headRef ? commitTarget(root, headRef) : { kind: "worktree" };
	const baseRef = command.base;
	const baseTarget = baseRef
		? commitTarget(
				root,
				command.threeDot ? mergeBase({ root, a: baseRef, b: headRef ?? "HEAD" }) : baseRef,
			)
		: commitTarget(root, mergeBase({ root, a: "HEAD", b: defaultBranchRef(root) }));
	const title = `${baseRef ?? "merge-base"}..${headRef ?? "working tree"}`;
	return buildDiffSession({
		root,
		title,
		base: baseTarget,
		head: headTarget,
		refresh,
	});
}
