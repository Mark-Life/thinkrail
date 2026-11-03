import type { FileInfo, ModuleInfo } from "../../core/types";

const HEAT_THRESHOLDS = [0, 1, 2, 4, 8, 16, 32] as const;

export interface MapNode {
	path: string;
	label: string;
	kind: "root" | "module" | "file";
	lines: number;
	commitWeight: number;
	children: MapNode[];
}

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface Tile<T> extends Rect {
	item: T;
}

export function heatOf(node: Pick<MapNode, "lines" | "commitWeight">) {
	return node.lines === 0 ? 0 : node.commitWeight / node.lines;
}

export function heatStep(commits: number) {
	let step = 0;
	for (const [index, threshold] of HEAT_THRESHOLDS.entries()) {
		if (commits >= threshold) step = index;
	}
	return step;
}

export function heatLegend() {
	return HEAT_THRESHOLDS.map((threshold, step) => {
		const next = HEAT_THRESHOLDS[step + 1];
		if (next === undefined) return { step, label: `${threshold}+` };
		return { step, label: next - threshold === 1 ? `${threshold}` : `${threshold}-${next - 1}` };
	});
}

function parentModule(path: string, known: ReadonlySet<string>) {
	let current = path;
	while (current.includes("/")) {
		current = current.slice(0, current.lastIndexOf("/"));
		if (known.has(current)) return current;
	}
	return undefined;
}

function moduleLabel(path: string, parent: string | undefined) {
	if (path === ".") return "repo root";
	if (parent) return path.slice(parent.length + 1).replace(/^src\//, "");
	return path.replace(/^(apps|packages)\//, "");
}

function sortBySize(node: MapNode) {
	node.children.sort((left, right) => right.lines - left.lines);
	for (const child of node.children) sortBySize(child);
}

function rollUp(node: MapNode) {
	for (const child of node.children) rollUp(child);
	if (node.kind === "file") return;
	node.lines = node.children.reduce((sum, child) => sum + child.lines, 0);
	node.commitWeight = node.children.reduce((sum, child) => sum + child.commitWeight, 0);
}

function prune(node: MapNode) {
	node.children = node.children.filter((child) => child.lines > 0);
	for (const child of node.children) prune(child);
}

export function buildMapTree(input: {
	files: readonly FileInfo[];
	modules: readonly ModuleInfo[];
	includeTests: boolean;
}) {
	const known = new Set(input.modules.map((module) => module.path));
	const root: MapNode = {
		path: "",
		label: "All packages",
		kind: "root",
		lines: 0,
		commitWeight: 0,
		children: [],
	};
	const nodes = new Map<string, MapNode>();
	for (const module of input.modules) {
		nodes.set(module.path, {
			path: module.path,
			label: moduleLabel(module.path, parentModule(module.path, known)),
			kind: "module",
			lines: 0,
			commitWeight: 0,
			children: [],
		});
	}
	for (const [path, node] of nodes) {
		const parent = parentModule(path, known);
		const owner = parent ? nodes.get(parent) : undefined;
		(owner ?? root).children.push(node);
	}
	for (const file of input.files) {
		if (file.isTest && !input.includeTests) continue;
		const owner = nodes.get(file.module);
		if (!owner) continue;
		const label = file.path.slice(file.module === "." ? 0 : file.module.length + 1);
		owner.children.push({
			path: file.path,
			label,
			kind: "file",
			lines: file.lines,
			commitWeight: file.lines * file.commits90d,
			children: [],
		});
	}
	rollUp(root);
	prune(root);
	sortBySize(root);
	return { root, nodes };
}

function worstRatio(input: { areas: readonly number[]; side: number }) {
	const total = input.areas.reduce((sum, area) => sum + area, 0);
	const largest = Math.max(...input.areas);
	const smallest = Math.min(...input.areas);
	const sideSquared = input.side * input.side;
	const totalSquared = total * total;
	return Math.max((sideSquared * largest) / totalSquared, totalSquared / (sideSquared * smallest));
}

function placeRow<T>(input: { row: { item: T; area: number }[]; rect: Rect }) {
	const { row, rect } = input;
	const total = row.reduce((sum, entry) => sum + entry.area, 0);
	const horizontal = rect.width >= rect.height;
	const thickness = horizontal ? total / rect.height : total / rect.width;
	const tiles: Tile<T>[] = [];
	let offset = 0;
	for (const entry of row) {
		const length = entry.area / thickness;
		tiles.push(
			horizontal
				? { item: entry.item, x: rect.x, y: rect.y + offset, width: thickness, height: length }
				: { item: entry.item, x: rect.x + offset, y: rect.y, width: length, height: thickness },
		);
		offset += length;
	}
	const remaining: Rect = horizontal
		? { x: rect.x + thickness, y: rect.y, width: rect.width - thickness, height: rect.height }
		: { x: rect.x, y: rect.y + thickness, width: rect.width, height: rect.height - thickness };
	return { tiles, remaining };
}

export function squarify<T>(input: {
	items: readonly T[];
	value: (item: T) => number;
	rect: Rect;
}) {
	const { rect, value } = input;
	const positive = input.items
		.filter((item) => value(item) > 0)
		.sort((left, right) => value(right) - value(left));
	const total = positive.reduce((sum, item) => sum + value(item), 0);
	if (total === 0 || rect.width <= 0 || rect.height <= 0) return [];
	const scale = (rect.width * rect.height) / total;
	const entries = positive.map((item) => ({ item, area: value(item) * scale }));
	const tiles: Tile<T>[] = [];
	let remaining = rect;
	let row: { item: T; area: number }[] = [];
	for (const entry of entries) {
		const side = Math.min(remaining.width, remaining.height);
		const next = [...row, entry];
		const nextAreas = next.map((candidate) => candidate.area);
		const rowAreas = row.map((candidate) => candidate.area);
		if (
			row.length === 0 ||
			worstRatio({ areas: nextAreas, side }) <= worstRatio({ areas: rowAreas, side })
		) {
			row = next;
			continue;
		}
		const placed = placeRow({ row, rect: remaining });
		tiles.push(...placed.tiles);
		remaining = placed.remaining;
		row = [entry];
	}
	if (row.length > 0) tiles.push(...placeRow({ row, rect: remaining }).tiles);
	return tiles;
}

export function findNode(root: MapNode, path: string | undefined): MapNode | undefined {
	if (!path) return root;
	if (root.path === path) return root;
	for (const child of root.children) {
		if (path === child.path || path.startsWith(`${child.path}/`) || child.path === ".") {
			const found = findNode(child, path);
			if (found) return found;
		}
	}
	return undefined;
}

export function breadcrumb(root: MapNode, path: string | undefined) {
	const trail: MapNode[] = [root];
	if (!path) return trail;
	let current = root;
	while (current.path !== path) {
		const next = current.children.find(
			(child) => child.path === path || path.startsWith(`${child.path}/`),
		);
		if (!next) return trail;
		trail.push(next);
		current = next;
	}
	return trail;
}
