import { cacheDirFor, readCachedGraph, writeCachedGraph } from "./cache";
import { checkoutCommit, sweepStaleCheckouts } from "./checkout";
import type { GraphRef, RepoGraph } from "./core/types";
import { affectsGraph, commitChurn, dirtyFiles, git, resolveCommit, worktreePaths } from "./git";
import { indexRepo } from "./indexer/indexRepo";

export type GraphTarget = { kind: "commit"; sha: string } | { kind: "worktree" };

interface LoadGraphInput {
	root: string;
	target: GraphTarget;
	refresh: boolean;
}

interface LoadedGraph {
	graph: RepoGraph;
	cached: boolean;
}

function withRef(graph: RepoGraph, ref: GraphRef) {
	const updated: RepoGraph = { ...graph, ref };
	return updated;
}

function indexCommit(input: { root: string; cacheDir: string; sha: string }) {
	const { root, cacheDir, sha } = input;
	const checkout = checkoutCommit({ repo: root, cacheDir, sha });
	try {
		return indexRepo({
			root: checkout.root,
			paths: checkout.paths,
			ref: { kind: "commit", sha },
			commits: commitChurn({ root, sha }),
		});
	} finally {
		checkout.cleanup();
	}
}

function loadCommit(input: { root: string; sha: string; refresh: boolean }): LoadedGraph {
	const { root, sha, refresh } = input;
	const cacheDir = cacheDirFor(root);
	sweepStaleCheckouts(cacheDir);
	const cached = refresh ? undefined : readCachedGraph({ cacheDir, sha });
	if (cached) return { graph: cached, cached: true };
	const graph = indexCommit({ root, cacheDir, sha });
	writeCachedGraph({ cacheDir, sha, graph });
	return { graph, cached: false };
}

function loadWorktree(input: { root: string; refresh: boolean }): LoadedGraph {
	const { root, refresh } = input;
	const sha = resolveCommit({ root, ref: "HEAD" });
	const dirty = dirtyFiles(root);
	const ref: GraphRef = { kind: "worktree", sha, dirtyFiles: dirty };
	if (!dirty.some(affectsGraph)) {
		const cacheDir = cacheDirFor(root);
		const cached = refresh ? undefined : readCachedGraph({ cacheDir, sha });
		if (cached) return { graph: withRef(cached, ref), cached: true };
		const graph = indexRepo({
			root,
			paths: worktreePaths(root),
			ref: { kind: "commit", sha },
			commits: commitChurn({ root, sha }),
		});
		writeCachedGraph({ cacheDir, sha, graph });
		return { graph: withRef(graph, ref), cached: false };
	}
	const graph = indexRepo({
		root,
		paths: worktreePaths(root),
		ref,
		commits: commitChurn({ root, sha }),
	});
	return { graph, cached: false };
}

export function loadGraph(input: LoadGraphInput) {
	const { root, target, refresh } = input;
	return target.kind === "commit"
		? loadCommit({ root, sha: target.sha, refresh })
		: loadWorktree({ root, refresh });
}

export function readSource(input: { root: string; graph: RepoGraph; file: string }) {
	const { root, graph, file } = input;
	if (!graph.files.some((entry) => entry.path === file)) return undefined;
	if (graph.ref.kind === "worktree") {
		return Bun.file(`${root}/${file}`).text();
	}
	return Promise.resolve(git({ cwd: root, args: ["show", `${graph.ref.sha}:${file}`] }));
}
