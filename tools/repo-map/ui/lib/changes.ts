import { diffWordsWithSpace } from "diff";
import type {
	ChangeGroup,
	CodeSymbol,
	ContractChange,
	EdgeKind,
	GraphDiff,
	GraphSide,
	SymbolChange,
	SymbolId,
} from "../../core/types";
import type { GraphIndex } from "./graphIndex";
import { isWireEdge } from "./graphIndex";
import { assignLayers, type LayoutEdge, type LayoutNode } from "./layout";

type ChangeStatus = SymbolChange["kind"];
type NodeStatus = ChangeStatus | "neighbor";

export const STATUS_MARKS: Record<ChangeStatus, string> = {
	added: "+",
	removed: "-",
	modified: "~",
	moved: ">",
};

export const FULL_GROUP_LIMIT = 24;
const FOCUS_NODE_LIMIT = 14;
const NEIGHBOR_LIMIT = 3;
const DIFF_NODE_WIDTH = 212;
const DIFF_NODE_HEIGHT = 48;

export interface DiffIndex {
	diff: GraphDiff;
	statusByHead: ReadonlyMap<SymbolId, ChangeStatus>;
	statusByBase: ReadonlyMap<SymbolId, ChangeStatus>;
	headForBase: ReadonlyMap<SymbolId, SymbolId>;
	groups: ReadonlyMap<string, ChangeGroup>;
}

export function changeHeadId(change: SymbolChange) {
	return change.kind === "removed" ? undefined : change.head;
}

export function changeBaseId(change: SymbolChange) {
	return change.kind === "added" ? undefined : change.base;
}

export function changeId(change: SymbolChange) {
	return change.kind === "removed" ? change.base : change.head;
}

export function changeSide(change: SymbolChange): GraphSide {
	return change.kind === "removed" ? "base" : "head";
}

export function buildDiffIndex(diff: GraphDiff): DiffIndex {
	const statusByHead = new Map<SymbolId, ChangeStatus>();
	const statusByBase = new Map<SymbolId, ChangeStatus>();
	const headForBase = new Map<SymbolId, SymbolId>();
	for (const change of [
		...diff.groups.flatMap((group) => group.symbolChanges),
		...diff.movedOnly,
	]) {
		const head = changeHeadId(change);
		const base = changeBaseId(change);
		if (head) statusByHead.set(head, change.kind);
		if (base) statusByBase.set(base, change.kind);
		if (head && base) headForBase.set(base, head);
	}
	return {
		diff,
		statusByHead,
		statusByBase,
		headForBase,
		groups: new Map(diff.groups.map((group) => [group.id, group])),
	};
}

export function changeCounts(changes: readonly SymbolChange[]) {
	const counts = { added: 0, removed: 0, modified: 0, moved: 0 };
	for (const change of changes) counts[change.kind] += 1;
	return counts;
}

export function totalCounts(diff: GraphDiff) {
	return changeCounts([...diff.groups.flatMap((group) => group.symbolChanges), ...diff.movedOnly]);
}

export interface DiffNode extends LayoutNode {
	symbol: CodeSymbol;
	side: GraphSide;
	status: NodeStatus;
	signatureChanged: boolean;
}

export interface DiffEdge extends LayoutEdge {
	status: "added" | "removed" | "same";
	kind: EdgeKind;
}

interface GroupGraph {
	nodes: DiffNode[];
	edges: DiffEdge[];
	focused: boolean;
	totalChanged: number;
	shownChanged: number;
}

function changeDegrees(group: ChangeGroup, canonical: (id: SymbolId) => SymbolId) {
	const degrees = new Map<SymbolId, number>();
	for (const { edge } of group.edgeChanges) {
		for (const id of [canonical(edge.from), canonical(edge.to)]) {
			degrees.set(id, (degrees.get(id) ?? 0) + 1);
		}
	}
	return degrees;
}

export function defaultFocus(input: { group: ChangeGroup; diffIndex: DiffIndex }) {
	const { group, diffIndex } = input;
	const canonical = (id: SymbolId) => diffIndex.headForBase.get(id) ?? id;
	const degrees = changeDegrees(group, canonical);
	const ids = group.symbolChanges.map(changeId);
	return [...ids].sort((left, right) => (degrees.get(right) ?? 0) - (degrees.get(left) ?? 0))[0];
}

function selectChanged(input: {
	group: ChangeGroup;
	focus: SymbolId | undefined;
	canonical: (id: SymbolId) => SymbolId;
}) {
	const { group, focus, canonical } = input;
	const all = group.symbolChanges.map(changeId);
	if (all.length <= FULL_GROUP_LIMIT || !focus) {
		return { ids: new Set(all.slice(0, FULL_GROUP_LIMIT)), focused: false };
	}
	const changed = new Set(all);
	const degrees = changeDegrees(group, canonical);
	const adjacent = new Set<SymbolId>();
	for (const { edge } of group.edgeChanges) {
		const from = canonical(edge.from);
		const to = canonical(edge.to);
		if (from === focus && changed.has(to)) adjacent.add(to);
		if (to === focus && changed.has(from)) adjacent.add(from);
	}
	const ranked = [...adjacent]
		.sort((left, right) => (degrees.get(right) ?? 0) - (degrees.get(left) ?? 0))
		.slice(0, FOCUS_NODE_LIMIT - 1);
	return { ids: new Set([focus, ...ranked]), focused: true };
}

export function buildGroupGraph(input: {
	group: ChangeGroup;
	diffIndex: DiffIndex;
	head: GraphIndex;
	base: GraphIndex;
	focus?: SymbolId | undefined;
}) {
	const { group, diffIndex, head, base, focus } = input;
	const canonical = (id: SymbolId) => diffIndex.headForBase.get(id) ?? id;
	const lookup = (id: SymbolId) => {
		const inHead = head.symbols.get(id);
		if (inHead) return { symbol: inHead, side: "head" as const };
		const inBase = base.symbols.get(id);
		return inBase ? { symbol: inBase, side: "base" as const } : undefined;
	};
	const changeById = new Map(group.symbolChanges.map((change) => [changeId(change), change]));
	const { ids, focused } = selectChanged({ group, focus, canonical });
	const inScope = (from: SymbolId, to: SymbolId) => !focused || from === focus || to === focus;
	const nodes = new Map<SymbolId, DiffNode>();
	const addNode = (id: SymbolId) => {
		if (nodes.has(id)) return;
		const found = lookup(id);
		if (!found) return;
		const change = changeById.get(id);
		const global = diffIndex.statusByHead.get(id) ?? diffIndex.statusByBase.get(id);
		nodes.set(id, {
			id,
			layer: 0,
			width: DIFF_NODE_WIDTH,
			height: DIFF_NODE_HEIGHT,
			symbol: found.symbol,
			side: found.side,
			status: change?.kind ?? global ?? "neighbor",
			signatureChanged: change?.kind === "modified" && change.signatureChanged,
		});
	};
	for (const id of ids) addNode(id);

	const edges = new Map<string, DiffEdge>();
	const neighborUse = new Map<SymbolId, number>();
	const allowNeighbor = (changed: SymbolId) => {
		const used = neighborUse.get(changed) ?? 0;
		if (used >= NEIGHBOR_LIMIT) return false;
		neighborUse.set(changed, used + 1);
		return true;
	};
	const addEdge = (edge: DiffEdge) => {
		const key = `${edge.from}|${edge.to}`;
		const existing = edges.get(key);
		if (!existing || existing.status === "same") edges.set(key, edge);
	};
	const wireFields = (edge: { kind: EdgeKind; label?: string }) =>
		isWireEdge(edge) && edge.label ? { label: edge.label, wide: true } : {};

	for (const { edge, kind } of group.edgeChanges) {
		const from = canonical(edge.from);
		const to = canonical(edge.to);
		const fromIn = ids.has(from);
		const toIn = ids.has(to);
		if ((!fromIn && !toIn) || !inScope(from, to)) continue;
		if (fromIn && !toIn) {
			if (!nodes.has(to) && !allowNeighbor(from)) continue;
			addNode(to);
		}
		if (toIn && !fromIn) {
			if (!nodes.has(from) && !allowNeighbor(to)) continue;
			addNode(from);
		}
		if (!nodes.has(from) || !nodes.has(to)) continue;
		addEdge({ from, to, status: kind, kind: edge.kind, ...wireFields(edge) });
	}
	for (const id of ids) {
		const touched = [...edges.values()].some((edge) => edge.from === id || edge.to === id);
		if (touched) continue;
		const callers = (head.incoming.get(id) ?? []).filter((edge) => edge.kind !== "implements");
		for (const edge of callers.slice(0, NEIGHBOR_LIMIT)) {
			addNode(edge.from);
			addEdge({ from: edge.from, to: id, status: "same", kind: edge.kind, ...wireFields(edge) });
		}
	}
	for (const node of [...nodes.values()]) {
		if (node.side !== "head") continue;
		for (const edge of head.outgoing.get(node.symbol.id) ?? []) {
			if (edge.kind === "implements" || !nodes.has(edge.to) || !inScope(edge.from, edge.to))
				continue;
			addEdge({
				from: edge.from,
				to: edge.to,
				status: "same",
				kind: edge.kind,
				...wireFields(edge),
			});
		}
	}

	const edgeList = [...edges.values()].filter((edge) => edge.from !== edge.to);
	const nodeIds = [...nodes.keys()];
	const withIncoming = new Set(edgeList.map((edge) => edge.to));
	const roots = nodeIds.filter((id) => !withIncoming.has(id));
	const layers = assignLayers({ ids: nodeIds, roots, edges: edgeList });
	const graph: GroupGraph = {
		nodes: [...nodes.values()].map((node) => ({ ...node, layer: layers.get(node.id) ?? 0 })),
		edges: edgeList,
		focused,
		totalChanged: group.symbolChanges.length,
		shownChanged: ids.size,
	};
	return graph;
}

export function groupByModule<T extends { module: string }>(items: readonly T[]) {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const bucket = groups.get(item.module);
		if (bucket) bucket.push(item);
		else groups.set(item.module, [item]);
	}
	return [...groups.entries()]
		.map(([module, members]) => ({ module, members }))
		.sort((left, right) => right.members.length - left.members.length);
}

export function resolveSymbols(input: { ids: readonly SymbolId[]; index: GraphIndex }) {
	return input.ids.flatMap((id) => {
		const symbol = input.index.symbols.get(id);
		return symbol ? [symbol] : [];
	});
}

type ContractBuckets = Record<"exports" | "signatures" | "wire" | "modules", ContractChange[]>;

export function bucketContracts(contracts: readonly ContractChange[]) {
	const buckets: ContractBuckets = { exports: [], signatures: [], wire: [], modules: [] };
	for (const contract of contracts) {
		if (contract.kind === "export-added" || contract.kind === "export-removed") {
			buckets.exports.push(contract);
		} else if (contract.kind === "signature-changed") {
			buckets.signatures.push(contract);
		} else if (contract.kind === "wire-method-added" || contract.kind === "wire-method-removed") {
			buckets.wire.push(contract);
		} else {
			buckets.modules.push(contract);
		}
	}
	return buckets;
}

export function hasCodeChanges(diff: GraphDiff) {
	return (
		diff.groups.length > 0 ||
		diff.movedOnly.length > 0 ||
		diff.contracts.length > 0 ||
		diff.formatOnlyFiles.length > 0
	);
}

const SIGNATURE_CONTEXT = 40;

export interface SignaturePart {
	text: string;
	changed: boolean;
}

function trimUnchanged(parts: readonly SignaturePart[], context: number) {
	return parts.map((part, position) => {
		if (part.changed || part.text.length <= context * 2) return part;
		const head = position === 0 ? "" : part.text.slice(0, context);
		const tail = position === parts.length - 1 ? "" : part.text.slice(-context);
		return { changed: false, text: `${head}...${tail}` };
	});
}

export function signatureDelta(input: { before: string; after: string; context?: number }) {
	const { before, after } = input;
	const context = input.context ?? SIGNATURE_CONTEXT;
	const chunks = diffWordsWithSpace(before, after);
	const side = (skip: "added" | "removed") =>
		trimUnchanged(
			chunks
				.filter((chunk) => !chunk[skip])
				.map((chunk) => ({ text: chunk.value, changed: chunk.added || chunk.removed })),
			context,
		);
	return { same: before === after, before: side("added"), after: side("removed") };
}
