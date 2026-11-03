import type { BlastRadius, CodeSymbol, Edge, RepoGraph, SymbolId } from "./types";

export interface CallerIndex {
	callers: Map<SymbolId, SymbolId[]>;
	symbols: Map<SymbolId, CodeSymbol>;
	hasCallers: Set<SymbolId>;
	implemented: Set<SymbolId>;
}

const CALLER_EDGES = new Set<Edge["kind"]>([
	"call",
	"new",
	"render",
	"wire-request",
	"wire-push",
	"tool-render",
]);
const TYPE_KINDS = new Set<CodeSymbol["kind"]>(["interface", "type", "class", "enum"]);
const NON_ENTRY_KINDS = new Set<CodeSymbol["kind"]>([
	"interface",
	"type",
	"enum",
	"const",
	"module",
]);

const DEFAULT_BLAST_LIMIT = 400;

function push(map: Map<SymbolId, SymbolId[]>, key: SymbolId, value: SymbolId) {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}

export function buildCallerIndex(graph: Pick<RepoGraph, "symbols" | "edges">) {
	const symbols = new Map(graph.symbols.map((symbol) => [symbol.id, symbol]));
	const callers = new Map<SymbolId, SymbolId[]>();
	const hasCallers = new Set<SymbolId>();
	const implemented = new Set<SymbolId>();
	for (const edge of graph.edges) {
		if (CALLER_EDGES.has(edge.kind)) {
			push(callers, edge.to, edge.from);
			hasCallers.add(edge.to);
		} else if (edge.kind === "implements") {
			push(callers, edge.from, edge.to);
			implemented.add(edge.to);
			implemented.add(edge.from);
		} else if (
			edge.kind === "type-ref" &&
			TYPE_KINDS.has(symbols.get(edge.to)?.kind ?? "function")
		) {
			push(callers, edge.to, edge.from);
		}
	}
	const index: CallerIndex = { callers, symbols, hasCallers, implemented };
	return index;
}

function isEntryPoint(index: CallerIndex, symbol: CodeSymbol) {
	if (symbol.kind === "wire-handler" || symbol.kind === "tool") return true;
	if (symbol.isTest || NON_ENTRY_KINDS.has(symbol.kind) || index.implemented.has(symbol.id)) {
		return false;
	}
	return !index.hasCallers.has(symbol.id);
}

export function blastRadius(input: {
	index: CallerIndex;
	seeds: readonly SymbolId[];
	limit?: number;
}) {
	const { index, seeds, limit = DEFAULT_BLAST_LIMIT } = input;
	const seen = new Set<SymbolId>(seeds);
	const queue = [...seeds];
	const reached: SymbolId[] = [];
	let truncated = false;
	for (let cursor = 0; cursor < queue.length && !truncated; cursor++) {
		const current = queue[cursor];
		if (current === undefined) break;
		for (const caller of index.callers.get(current) ?? []) {
			if (seen.has(caller)) continue;
			if (reached.length >= limit) {
				truncated = true;
				break;
			}
			seen.add(caller);
			reached.push(caller);
			queue.push(caller);
		}
	}
	const blast: BlastRadius = {
		callers: reached,
		entryPoints: [],
		tests: [],
		truncated,
	};
	for (const id of reached) {
		const symbol = index.symbols.get(id);
		if (!symbol) continue;
		if (symbol.isTest) blast.tests.push(id);
		else if (isEntryPoint(index, symbol)) blast.entryPoints.push(id);
	}
	return blast;
}

export function mergeBlast(a: BlastRadius, b: BlastRadius) {
	const merged: BlastRadius = {
		callers: [...new Set([...a.callers, ...b.callers])],
		entryPoints: [...new Set([...a.entryPoints, ...b.entryPoints])],
		tests: [...new Set([...a.tests, ...b.tests])],
		truncated: a.truncated || b.truncated,
	};
	return merged;
}
