import {
	type CodeSymbol,
	type Edge,
	type EdgeKind,
	GRAPH_SCHEMA_VERSION,
	type RepoGraph,
	type SymbolId,
} from "../../core/types";

export function sid(file: string, name: string) {
	return `${file}#${name}` as SymbolId;
}

export function makeSymbol(
	input: Partial<CodeSymbol> & { file: string; name: string },
): CodeSymbol {
	return {
		id: sid(input.file, input.name),
		kind: "function",
		module: input.file.slice(0, input.file.lastIndexOf("/")),
		startLine: 1,
		endLine: 2,
		exported: true,
		barrelExported: false,
		isTest: false,
		bodyHash: "b",
		signatureHash: "s",
		signature: "()",
		...input,
	};
}

export function makeEdge(input: {
	from: SymbolId;
	to: SymbolId;
	kind?: EdgeKind;
	line?: number;
	label?: string;
}): Edge {
	const edge: Edge = {
		from: input.from,
		to: input.to,
		kind: input.kind ?? "call",
		line: input.line ?? 1,
		count: 1,
	};
	return input.label === undefined ? edge : { ...edge, label: input.label };
}

export function makeGraph(input: { symbols: CodeSymbol[]; edges?: Edge[] }): RepoGraph {
	return {
		schemaVersion: GRAPH_SCHEMA_VERSION,
		ref: { kind: "commit", sha: "abc" },
		symbols: input.symbols,
		edges: input.edges ?? [],
		files: [],
		modules: [],
		moduleEdges: [],
		stats: {
			files: 0,
			callSites: 0,
			resolvedInRepo: 0,
			resolvedExternal: 0,
			unresolved: 0,
			dynamicCalls: 0,
			wireMethods: 0,
			wireMethodsWithHandler: 0,
			wireMethodsWithCaller: 0,
			wireDynamicRequests: 0,
			wireUnhandledRequests: 0,
			wireChannels: 0,
			wireChannelsLinked: 0,
			tools: 0,
			toolRenderers: 0,
			toolsLinked: 0,
			durationMs: 0,
		},
	};
}
