import type { CodeSymbol, EdgeKind, SymbolId } from "../../core/types";
import { type GraphIndex, isTypeLike, isWireEdge } from "./graphIndex";
import type { LayoutEdge, LayoutNode } from "./layout";

export const FAN_OUT_LIMIT = 8;
const REVEALED_LIMIT = 40;
const TRACE_NODE_WIDTH = 212;
const TRACE_NODE_HEIGHT = 48;
const TRACE_MORE_HEIGHT = 30;

type TraceDirection = "caller" | "callee";

export interface TraceSymbolNode extends LayoutNode {
	type: "symbol";
	symbol: CodeSymbol;
	direction: TraceDirection | "center";
	hiddenNeighbors: number;
	expanded: boolean;
}

export interface TraceMoreNode extends LayoutNode {
	type: "more";
	owner: SymbolId;
	direction: TraceDirection;
	hidden: number;
	revealKey: string;
	exhausted: boolean;
}

export type TraceNode = TraceSymbolNode | TraceMoreNode;

export interface TraceEdge extends LayoutEdge {
	kind: EdgeKind | "more";
	line: number;
}

interface Trace {
	nodes: TraceNode[];
	edges: TraceEdge[];
	hiddenTypeRefs: number;
	hiddenTests: number;
	typesForced: boolean;
}

interface TraceLink {
	other: SymbolId;
	from: SymbolId;
	to: SymbolId;
	kind: EdgeKind;
	line: number;
	count: number;
	label?: string;
}

const KIND_PRIORITY: Record<EdgeKind, number> = {
	"wire-request": 0,
	"wire-push": 0,
	"tool-render": 0,
	call: 1,
	new: 1,
	render: 2,
	implements: 3,
	"type-ref": 4,
};

function linkFor(input: {
	edge: {
		from: SymbolId;
		to: SymbolId;
		kind: EdgeKind;
		line: number;
		count: number;
		label?: string;
	};
	other: SymbolId;
	flip?: boolean;
}): TraceLink {
	const { edge, other, flip } = input;
	const link: TraceLink = {
		other,
		from: flip ? edge.to : edge.from,
		to: flip ? edge.from : edge.to,
		kind: edge.kind,
		line: edge.line,
		count: edge.count,
	};
	return edge.label === undefined ? link : { ...link, label: edge.label };
}

function neighborLinks(input: { index: GraphIndex; id: SymbolId; direction: TraceDirection }) {
	const { index, id, direction } = input;
	const outgoing = index.outgoing.get(id) ?? [];
	const incoming = index.incoming.get(id) ?? [];
	if (direction === "callee") {
		return [
			...outgoing
				.filter((edge) => edge.kind !== "implements")
				.map((edge) => linkFor({ edge, other: edge.to })),
			...incoming
				.filter((edge) => edge.kind === "implements")
				.map((edge) => linkFor({ edge, other: edge.from, flip: true })),
		];
	}
	return [
		...incoming
			.filter((edge) => edge.kind !== "implements")
			.map((edge) => linkFor({ edge, other: edge.from })),
		...outgoing
			.filter((edge) => edge.kind === "implements")
			.map((edge) => linkFor({ edge, other: edge.to, flip: true })),
	];
}

function mergeByOther(links: readonly TraceLink[]) {
	const merged = new Map<SymbolId, TraceLink>();
	for (const link of links) {
		const existing = merged.get(link.other);
		if (!existing || KIND_PRIORITY[link.kind] < KIND_PRIORITY[existing.kind]) {
			merged.set(link.other, link);
		}
	}
	return [...merged.values()];
}

function rankLinks(input: { links: TraceLink[]; index: GraphIndex }) {
	const { links, index } = input;
	const nameOf = (id: SymbolId) => index.symbols.get(id)?.name ?? id;
	return [...links].sort(
		(left, right) =>
			KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind] ||
			right.count - left.count ||
			nameOf(left.other).localeCompare(nameOf(right.other)),
	);
}

export function moreKey(direction: TraceDirection, id: SymbolId) {
	return `${direction === "caller" ? "in" : "out"}:${id}`;
}

interface VisibleLinks {
	links: TraceLink[];
	typeRefs: number;
	tests: number;
}

function visibleLinks(input: {
	index: GraphIndex;
	id: SymbolId;
	direction: TraceDirection;
	types: boolean;
	tests: boolean;
}): VisibleLinks {
	const { index, id, direction, types, tests } = input;
	const all = neighborLinks({ index, id, direction }).filter((link) =>
		index.symbols.has(link.other),
	);
	const nonSelf = all.filter((link) => link.other !== id);
	const hiddenTypes = types ? [] : nonSelf.filter((link) => link.kind === "type-ref");
	const typed = types ? nonSelf : nonSelf.filter((link) => link.kind !== "type-ref");
	const merged = mergeByOther(typed);
	const production = tests
		? merged
		: merged.filter((link) => !index.symbols.get(link.other)?.isTest);
	return {
		links: rankLinks({ links: production, index }),
		typeRefs: new Set(hiddenTypes.map((link) => link.other)).size,
		tests: merged.length - production.length,
	};
}

export function buildTrace(input: {
	index: GraphIndex;
	center: SymbolId;
	expanded: ReadonlySet<string>;
	revealed: ReadonlySet<string>;
	types: boolean;
	tests: boolean;
}) {
	const { index, center, expanded, revealed } = input;
	const centerSymbol = index.symbols.get(center);
	if (!centerSymbol) return undefined;
	const typesForced = isTypeLike(centerSymbol);
	const types = input.types || typesForced;
	const tests = input.tests || centerSymbol.isTest;
	const placed = new Map<SymbolId, TraceSymbolNode>();
	const nodes: TraceNode[] = [];
	const edges: TraceEdge[] = [];
	const edgeKeys = new Set<string>();
	let hiddenTypeRefs = 0;
	let hiddenTests = 0;

	const place = (symbol: CodeSymbol, layer: number, direction: TraceSymbolNode["direction"]) => {
		const node: TraceSymbolNode = {
			type: "symbol",
			id: symbol.id,
			symbol,
			layer,
			width: TRACE_NODE_WIDTH,
			height: TRACE_NODE_HEIGHT,
			direction,
			hiddenNeighbors: 0,
			expanded: direction === "center" || expanded.has(symbol.id),
		};
		placed.set(symbol.id, node);
		nodes.push(node);
		return node;
	};

	const addEdge = (link: TraceLink) => {
		const key = `${link.from}|${link.to}`;
		if (edgeKeys.has(key)) return;
		edgeKeys.add(key);
		const wire = isWireEdge(link);
		const label = wire ? link.label : link.kind === "implements" ? "impl" : undefined;
		const edge: TraceEdge = { from: link.from, to: link.to, kind: link.kind, line: link.line };
		edges.push(label === undefined ? edge : { ...edge, label, ...(wire ? { wide: true } : {}) });
	};

	const walk = (direction: TraceDirection) => {
		const step = direction === "caller" ? -1 : 1;
		const frontier: SymbolId[] = [center];
		for (let cursor = 0; cursor < frontier.length; cursor++) {
			const id = frontier[cursor];
			const owner = id === undefined ? undefined : placed.get(id);
			if (id === undefined || !owner) continue;
			const visible = visibleLinks({ index, id, direction, types, tests });
			if (id === center || owner.expanded) {
				hiddenTypeRefs += visible.typeRefs;
				hiddenTests += visible.tests;
			}
			if (!owner.expanded) {
				owner.hiddenNeighbors = visible.links.length;
				continue;
			}
			const key = moreKey(direction, id);
			const limit = revealed.has(key) ? REVEALED_LIMIT : FAN_OUT_LIMIT;
			const shownLinks = visible.links.slice(0, limit);
			for (const link of shownLinks) {
				const other = index.symbols.get(link.other);
				if (!other) continue;
				if (!placed.has(link.other)) {
					place(other, owner.layer + step, direction);
					frontier.push(link.other);
				}
				addEdge(link);
			}
			const hidden = visible.links.length - shownLinks.length;
			if (hidden > 0) {
				const more: TraceMoreNode = {
					type: "more",
					id: `more:${key}`,
					owner: id,
					layer: owner.layer + step,
					width: TRACE_NODE_WIDTH,
					height: TRACE_MORE_HEIGHT,
					direction,
					hidden,
					revealKey: key,
					exhausted: revealed.has(key),
				};
				nodes.push(more);
				const edge = {
					from: direction === "caller" ? more.id : id,
					to: direction === "caller" ? id : more.id,
					kind: "more" as const,
					line: 0,
				};
				edges.push(edge);
			}
		}
	};

	place(centerSymbol, 0, "center");
	walk("caller");
	walk("callee");
	const trace: Trace = { nodes, edges, hiddenTypeRefs, hiddenTests, typesForced };
	return trace;
}
