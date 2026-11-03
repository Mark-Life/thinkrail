import { join, relative } from "node:path";
import type { CodeSymbol, Edge, FileInfo, GraphRef, RepoGraph } from "../core/types";
import { GRAPH_SCHEMA_VERSION } from "../core/types";
import { collectEdges, type EdgeSink } from "./edges";
import { collectExportInfo } from "./exportInfo";
import { buildModuleEdges, buildModules, createModuleLocator } from "./modules";
import { buildProgram } from "./program";
import { extractFileSymbols } from "./symbols";
import { createSymbolTable } from "./table";
import { discoverTransport, extractWireEdges } from "./wire";

interface IndexInput {
	root: string;
	paths: readonly string[];
	ref: GraphRef;
	commits: ReadonlyMap<string, number>;
}

function byText(a: string, b: string) {
	return a < b ? -1 : a > b ? 1 : 0;
}

function compareEdges(a: Edge, b: Edge) {
	return (
		byText(a.from, b.from) ||
		byText(a.to, b.to) ||
		byText(a.kind, b.kind) ||
		byText(a.label ?? "", b.label ?? "")
	);
}

export function indexRepo(input: IndexInput) {
	const started = performance.now();
	const { root, paths, ref, commits } = input;
	const repo = buildProgram({ root, paths });
	const { moduleOf, packageOf } = createModuleLocator(paths);
	const exports = collectExportInfo(repo);
	const transport = discoverTransport({ repo, packageOf });
	const table = createSymbolTable();
	const files: FileInfo[] = [];
	for (const { path, source, isTest } of repo.sources) {
		const module = moduleOf(path);
		const hashes = extractFileSymbols({
			source,
			path,
			module,
			isTest,
			root,
			checker: repo.checker,
			table,
			exports,
			wireMethods: transport.methods,
		});
		const resolved = repo.imports.get(join(root, path)) ?? [];
		const imports = [...resolved]
			.filter((target) => target.startsWith(root))
			.map((target) => relative(root, target))
			.filter((target) => target !== path)
			.sort(byText);
		files.push({
			path,
			module,
			lines: source.getLineStarts().length,
			isTest,
			commits90d: commits.get(path) ?? 0,
			imports,
			...hashes,
		});
	}
	const sink: EdgeSink = { edges: new Map() };
	const resolver = { repo, table, moduleOf, memo: new Map() };
	const callStats = collectEdges({ ...resolver, sink });
	const wireStats = extractWireEdges({ ...resolver, sink, transport, packageOf });
	const symbols: CodeSymbol[] = [...table.byId.values()].sort((a, b) => byText(a.id, b.id));
	const graph: RepoGraph = {
		schemaVersion: GRAPH_SCHEMA_VERSION,
		ref,
		symbols,
		edges: [...sink.edges.values()].sort(compareEdges),
		files,
		modules: buildModules({ root, files }),
		moduleEdges: buildModuleEdges(files),
		stats: {
			files: files.length,
			...callStats,
			...wireStats,
			durationMs: Math.round(performance.now() - started),
		},
	};
	return graph;
}
