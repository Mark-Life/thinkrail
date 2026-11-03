import type { CodeSymbol, SymbolId, SymbolKind } from "../../core/types";
import type { GraphIndex } from "./graphIndex";

export type SearchFilter =
	| "all"
	| "function"
	| "component"
	| "hook"
	| "type"
	| "wire"
	| "file"
	| "module";

export const SEARCH_FILTERS: readonly { id: SearchFilter; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "function", label: "Functions" },
	{ id: "component", label: "Components" },
	{ id: "hook", label: "Hooks" },
	{ id: "type", label: "Types" },
	{ id: "wire", label: "Wire" },
	{ id: "file", label: "Files" },
	{ id: "module", label: "Modules" },
];

export type SearchEntry =
	| {
			type: "symbol";
			id: SymbolId;
			label: string;
			detail: string;
			kind: SymbolKind;
			weight: number;
			lower: string;
	  }
	| { type: "file"; path: string; label: string; detail: string; weight: number; lower: string }
	| { type: "module"; path: string; label: string; detail: string; weight: number; lower: string };

const FILTER_KINDS: Partial<Record<SearchFilter, readonly SymbolKind[]>> = {
	function: ["function", "method", "class", "const"],
	component: ["component"],
	hook: ["hook"],
	type: ["interface", "type", "enum"],
	wire: ["wire-handler", "tool"],
};

function symbolWeight(symbol: CodeSymbol) {
	let weight = 0;
	if (symbol.barrelExported) weight += 3;
	else if (symbol.exported) weight += 2;
	if (symbol.isTest) weight -= 6;
	if (symbol.kind === "wire-handler" || symbol.kind === "component" || symbol.kind === "hook") {
		weight += 1;
	}
	if (symbol.parent) weight -= 1;
	return weight;
}

export function buildSearchEntries(index: GraphIndex): SearchEntry[] {
	const symbols: SearchEntry[] = index.graph.symbols
		.filter((symbol) => symbol.kind !== "module")
		.map((symbol) => ({
			type: "symbol",
			id: symbol.id,
			label: symbol.name,
			detail: symbol.file,
			kind: symbol.kind,
			weight: symbolWeight(symbol),
			lower: symbol.name.toLowerCase(),
		}));
	const files: SearchEntry[] = index.graph.files.map((file) => ({
		type: "file",
		path: file.path,
		label: file.path.slice(file.path.lastIndexOf("/") + 1),
		detail: file.path,
		weight: file.isTest ? -6 : 0,
		lower: file.path.toLowerCase(),
	}));
	const modules: SearchEntry[] = index.graph.modules.map((module) => ({
		type: "module",
		path: module.path,
		label: module.path,
		detail: module.title ?? `${module.files} files`,
		weight: 2,
		lower: module.path.toLowerCase(),
	}));
	return [...symbols, ...files, ...modules];
}

function isWordBoundary(text: string, position: number) {
	if (position === 0) return true;
	const previous = text[position - 1] ?? "";
	return !/[a-z0-9]/i.test(previous);
}

function camelInitials(label: string) {
	return label.replace(/[a-z0-9]+/g, "").toLowerCase();
}

function subsequencePenalty(text: string, query: string) {
	let position = -1;
	let start = -1;
	for (const character of query) {
		position = text.indexOf(character, position + 1);
		if (position === -1) return undefined;
		if (start === -1) start = position;
	}
	return position - start - query.length + 1;
}

export function scoreEntry(entry: Pick<SearchEntry, "label" | "lower">, query: string) {
	const label = entry.label.toLowerCase();
	if (label === query) return 1000;
	if (label.startsWith(query)) return 800 - Math.min(100, label.length - query.length);
	const inLabel = label.indexOf(query);
	if (inLabel !== -1) {
		const camel = entry.label[inLabel] !== entry.label[inLabel]?.toLowerCase();
		const boundary = camel || isWordBoundary(label, inLabel);
		return (boundary ? 650 : 500) - Math.min(100, label.length - query.length);
	}
	if (camelInitials(entry.label).startsWith(query)) return 450;
	const inPath = entry.lower.indexOf(query);
	if (inPath !== -1) return 300 - Math.min(100, inPath);
	const penalty = query.length >= 3 ? subsequencePenalty(label, query) : undefined;
	if (penalty !== undefined && penalty < 12) return 150 - penalty * 5;
	return undefined;
}

function matchesFilter(entry: SearchEntry, filter: SearchFilter) {
	if (filter === "all") return true;
	if (filter === "file" || filter === "module") return entry.type === filter;
	if (entry.type !== "symbol") return false;
	return FILTER_KINDS[filter]?.includes(entry.kind) ?? false;
}

export function searchEntries(input: {
	entries: readonly SearchEntry[];
	query: string;
	filter: SearchFilter;
	limit: number;
}) {
	const query = input.query.trim().toLowerCase();
	if (!query) return [];
	const scored: { entry: SearchEntry; score: number }[] = [];
	for (const entry of input.entries) {
		if (!matchesFilter(entry, input.filter)) continue;
		const score = scoreEntry(entry, query);
		if (score !== undefined) scored.push({ entry, score: score + entry.weight * 10 });
	}
	return scored
		.sort(
			(left, right) =>
				right.score - left.score || left.entry.label.localeCompare(right.entry.label),
		)
		.slice(0, input.limit)
		.map((item) => item.entry);
}
