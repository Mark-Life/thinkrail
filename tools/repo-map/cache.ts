import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GRAPH_SCHEMA_VERSION, type RepoGraph } from "./core/types";
import { commonDir } from "./git";

export function cacheDirFor(root: string) {
	return join(commonDir(root), "repo-map");
}

function cachePath(input: { cacheDir: string; sha: string }) {
	return join(input.cacheDir, `v${GRAPH_SCHEMA_VERSION}-${input.sha}.json`);
}

export function readCachedGraph(input: { cacheDir: string; sha: string }) {
	const path = cachePath(input);
	if (!existsSync(path)) return undefined;
	try {
		const graph: RepoGraph = JSON.parse(readFileSync(path, "utf8"));
		return graph.schemaVersion === GRAPH_SCHEMA_VERSION ? graph : undefined;
	} catch {
		return undefined;
	}
}

export function writeCachedGraph(input: { cacheDir: string; sha: string; graph: RepoGraph }) {
	mkdirSync(input.cacheDir, { recursive: true });
	const path = cachePath(input);
	const temporary = `${path}.${process.pid}.partial`;
	writeFileSync(temporary, JSON.stringify(input.graph));
	renameSync(temporary, path);
}
