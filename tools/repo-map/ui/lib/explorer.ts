import type { CodeSymbol, FileInfo, SymbolId } from "../../core/types";

interface DirNode {
	path: string;
	name: string;
	dirs: DirNode[];
	files: FileInfo[];
}

export type ExplorerRow =
	| { kind: "dir"; key: string; name: string; depth: number; open: boolean }
	| { kind: "file"; key: string; name: string; depth: number; open: boolean; symbols: number }
	| { kind: "symbol"; key: string; symbol: CodeSymbol; depth: number };

const RECENT_LIMIT = 30;

function childName(path: string, parent: string) {
	return parent ? path.slice(parent.length + 1) : path;
}

function compress(node: DirNode, parent: string): DirNode {
	const onlyDir = node.dirs[0];
	if (node.files.length === 0 && node.dirs.length === 1 && onlyDir) {
		return compress(onlyDir, parent);
	}
	return {
		...node,
		name: childName(node.path, parent),
		dirs: node.dirs
			.map((dir) => compress(dir, node.path))
			.sort((left, right) => left.name.localeCompare(right.name)),
		files: [...node.files].sort((left, right) => left.path.localeCompare(right.path)),
	};
}

export function buildFileTree(files: readonly FileInfo[]) {
	const root: DirNode = { path: "", name: "", dirs: [], files: [] };
	const dirs = new Map<string, DirNode>([["", root]]);
	const dirAt = (path: string): DirNode => {
		const existing = dirs.get(path);
		if (existing) return existing;
		const split = path.lastIndexOf("/");
		const parent = dirAt(split < 0 ? "" : path.slice(0, split));
		const created: DirNode = { path, name: path.slice(split + 1), dirs: [], files: [] };
		parent.dirs.push(created);
		dirs.set(path, created);
		return created;
	};
	for (const file of files) {
		const split = file.path.lastIndexOf("/");
		dirAt(split < 0 ? "" : file.path.slice(0, split)).files.push(file);
	}
	const compressedRoot: DirNode = {
		...root,
		dirs: root.dirs
			.map((dir) => compress(dir, ""))
			.sort((left, right) => left.name.localeCompare(right.name)),
		files: [...root.files].sort((left, right) => left.path.localeCompare(right.path)),
	};
	return compressedRoot;
}

function parseTerms(filter: string) {
	return filter.toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesAll(text: string, terms: readonly string[]) {
	const lower = text.toLowerCase();
	return terms.every((term) => lower.includes(term));
}

function listedSymbols(symbols: readonly CodeSymbol[]) {
	const listed = symbols
		.filter((symbol) => symbol.kind !== "module")
		.sort((left, right) => left.startLine - right.startLine);
	const nesting = new Map<SymbolId, number>();
	return listed.map((symbol) => {
		const parent = symbol.parent ? nesting.get(symbol.parent) : undefined;
		const level = parent === undefined ? 0 : parent + 1;
		nesting.set(symbol.id, level);
		return { symbol, level };
	});
}

export function flattenExplorer(input: {
	tree: DirNode;
	expanded: ReadonlySet<string>;
	fileSymbols: ReadonlyMap<string, CodeSymbol[]>;
	filter: string;
}) {
	const { tree, expanded, fileSymbols } = input;
	const terms = parseTerms(input.filter);
	const filtering = terms.length > 0;

	const fileRows = (file: FileInfo, depth: number): ExplorerRow[] => {
		const all = listedSymbols(fileSymbols.get(file.path) ?? []);
		const pathMatches = matchesAll(file.path, terms);
		const shown = pathMatches ? all : all.filter(({ symbol }) => matchesAll(symbol.name, terms));
		if (filtering && !pathMatches && shown.length === 0) return [];
		const open = filtering ? shown.length > 0 && !pathMatches : expanded.has(file.path);
		const isOpen = open || expanded.has(file.path);
		const header: ExplorerRow = {
			kind: "file",
			key: file.path,
			name: file.path.slice(file.path.lastIndexOf("/") + 1),
			depth,
			open: isOpen,
			symbols: all.length,
		};
		if (!isOpen) return [header];
		const symbolRows = shown.map(
			({ symbol, level }): ExplorerRow => ({
				kind: "symbol",
				key: symbol.id,
				symbol,
				depth: depth + 1 + level,
			}),
		);
		return [header, ...symbolRows];
	};

	const dirRows = (node: DirNode, depth: number): ExplorerRow[] => {
		const inside = (childDepth: number) => [
			...node.dirs.flatMap((dir) => dirRows(dir, childDepth)),
			...node.files.flatMap((file) => fileRows(file, childDepth)),
		];
		if (filtering) {
			const children = inside(depth + 1);
			if (children.length === 0) return [];
			return [{ kind: "dir", key: node.path, name: node.name, depth, open: true }, ...children];
		}
		const open = expanded.has(node.path);
		const header: ExplorerRow = { kind: "dir", key: node.path, name: node.name, depth, open };
		return open ? [header, ...inside(depth + 1)] : [header];
	};

	return [
		...tree.dirs.flatMap((dir) => dirRows(dir, 0)),
		...tree.files.flatMap((file) => fileRows(file, 0)),
	];
}

export function revealKeys(tree: DirNode, file: string) {
	const keys = [file];
	const walk = (node: DirNode) => {
		for (const dir of node.dirs) {
			if (file.startsWith(`${dir.path}/`)) {
				keys.push(dir.path);
				walk(dir);
				return;
			}
		}
	};
	walk(tree);
	return keys;
}

export function pushRecent(recent: readonly SymbolId[], symbol: SymbolId) {
	return [symbol, ...recent.filter((id) => id !== symbol)].slice(0, RECENT_LIMIT);
}
