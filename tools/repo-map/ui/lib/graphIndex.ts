import type {
	CodeSymbol,
	Edge,
	FileInfo,
	ModuleEdge,
	ModuleInfo,
	RepoGraph,
	SymbolId,
} from "../../core/types";

export interface GraphIndex {
	graph: RepoGraph;
	symbols: ReadonlyMap<SymbolId, CodeSymbol>;
	outgoing: ReadonlyMap<SymbolId, Edge[]>;
	incoming: ReadonlyMap<SymbolId, Edge[]>;
	files: ReadonlyMap<string, FileInfo>;
	modules: ReadonlyMap<string, ModuleInfo>;
	fileSymbols: ReadonlyMap<string, CodeSymbol[]>;
	moduleSymbols: ReadonlyMap<string, CodeSymbol[]>;
	moduleOut: ReadonlyMap<string, ModuleEdge[]>;
	moduleIn: ReadonlyMap<string, ModuleEdge[]>;
	children: ReadonlyMap<SymbolId, CodeSymbol[]>;
	fileEdges: ReadonlyMap<string, Edge[]>;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
	const bucket = map.get(key);
	if (bucket) bucket.push(value);
	else map.set(key, [value]);
}

export function buildGraphIndex(graph: RepoGraph): GraphIndex {
	const symbols = new Map(graph.symbols.map((symbol) => [symbol.id, symbol]));
	const outgoing = new Map<SymbolId, Edge[]>();
	const incoming = new Map<SymbolId, Edge[]>();
	const fileEdges = new Map<string, Edge[]>();
	for (const edge of graph.edges) {
		push(outgoing, edge.from, edge);
		push(incoming, edge.to, edge);
		const from = symbols.get(edge.from);
		if (from) push(fileEdges, from.file, edge);
	}
	const fileSymbols = new Map<string, CodeSymbol[]>();
	const moduleSymbols = new Map<string, CodeSymbol[]>();
	const children = new Map<SymbolId, CodeSymbol[]>();
	for (const symbol of graph.symbols) {
		push(fileSymbols, symbol.file, symbol);
		push(moduleSymbols, symbol.module, symbol);
		if (symbol.parent) push(children, symbol.parent, symbol);
	}
	for (const bucket of fileSymbols.values()) {
		bucket.sort((left, right) => left.startLine - right.startLine);
	}
	const moduleOut = new Map<string, ModuleEdge[]>();
	const moduleIn = new Map<string, ModuleEdge[]>();
	for (const edge of graph.moduleEdges) {
		push(moduleOut, edge.from, edge);
		push(moduleIn, edge.to, edge);
	}
	for (const bucket of [...moduleOut.values(), ...moduleIn.values()]) {
		bucket.sort((left, right) => right.imports - left.imports);
	}
	return {
		graph,
		symbols,
		outgoing,
		incoming,
		files: new Map(graph.files.map((file) => [file.path, file])),
		modules: new Map(graph.modules.map((module) => [module.path, module])),
		fileSymbols,
		moduleSymbols,
		moduleOut,
		moduleIn,
		children,
		fileEdges,
	};
}

export function isWireEdge(edge: Pick<Edge, "kind">) {
	return edge.kind === "wire-request" || edge.kind === "wire-push" || edge.kind === "tool-render";
}

export function callersOf(index: GraphIndex, id: SymbolId) {
	return (index.incoming.get(id) ?? []).filter((edge) => edge.kind !== "type-ref");
}

export function calleesOf(index: GraphIndex, id: SymbolId) {
	return (index.outgoing.get(id) ?? []).filter(
		(edge) => edge.kind !== "type-ref" && edge.kind !== "implements",
	);
}

export function usedByOf(index: GraphIndex, id: SymbolId) {
	return (index.incoming.get(id) ?? []).filter((edge) => edge.kind === "type-ref");
}

export function isTypeLike(symbol: Pick<CodeSymbol, "kind">) {
	return symbol.kind === "interface" || symbol.kind === "type" || symbol.kind === "enum";
}

export function startingPoints(index: GraphIndex, limit = 6) {
	const byCount = (id: SymbolId) => (index.incoming.get(id) ?? []).length;
	const fanOut = (id: SymbolId) => (index.outgoing.get(id) ?? []).length;
	const production = index.graph.symbols.filter((symbol) => !symbol.isTest);
	const topBy = (input: { kind: CodeSymbol["kind"]; score: (id: SymbolId) => number }) =>
		production
			.filter((symbol) => symbol.kind === input.kind)
			.sort((left, right) => input.score(right.id) - input.score(left.id))
			.slice(0, limit);
	return {
		handlers: topBy({ kind: "wire-handler", score: byCount }),
		components: topBy({ kind: "component", score: fanOut }),
		hooks: topBy({ kind: "hook", score: byCount }),
	};
}
