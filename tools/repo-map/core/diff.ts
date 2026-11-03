import { blastRadius, buildCallerIndex, type CallerIndex, mergeBlast } from "./blast";
import type {
	ChangeGroup,
	CodeSymbol,
	ContractChange,
	Edge,
	EdgeChange,
	EdgeKind,
	GraphDiff,
	RepoGraph,
	SymbolChange,
	SymbolId,
} from "./types";

interface DiffInput {
	base: RepoGraph;
	head: RepoGraph;
	nonCodeFiles?: readonly string[];
	blastLimit?: number;
}

const GROUP_EDGES = new Set<EdgeKind>([
	"call",
	"new",
	"render",
	"implements",
	"wire-request",
	"wire-push",
	"tool-render",
]);
const MIN_RENAME_LINES = 3;

function byId(graph: RepoGraph) {
	return new Map(graph.symbols.map((symbol) => [symbol.id, symbol]));
}

function compareText(a: string, b: string) {
	return a < b ? -1 : a > b ? 1 : 0;
}

function pairMoves(removed: readonly CodeSymbol[], added: readonly CodeSymbol[]) {
	const available = new Map<string, CodeSymbol[]>();
	for (const symbol of added) {
		if (symbol.kind === "module") continue;
		const list = available.get(symbol.bodyHash) ?? [];
		list.push(symbol);
		available.set(symbol.bodyHash, list);
	}
	const pairs: { base: CodeSymbol; head: CodeSymbol }[] = [];
	const take = (base: CodeSymbol, match: (head: CodeSymbol) => boolean) => {
		const list = available.get(base.bodyHash);
		const index = list?.findIndex(match) ?? -1;
		const head = list?.[index];
		if (!list || !head || index < 0) return false;
		list.splice(index, 1);
		pairs.push({ base, head });
		return true;
	};
	const remaining: CodeSymbol[] = [];
	for (const base of removed) {
		if (base.kind === "module") continue;
		if (!take(base, (head) => head.name === base.name && head.kind === base.kind)) {
			remaining.push(base);
		}
	}
	for (const base of remaining) {
		if (base.endLine - base.startLine + 1 < MIN_RENAME_LINES) continue;
		take(base, (head) => head.kind === base.kind);
	}
	return pairs;
}

function classifySymbols(input: {
	base: RepoGraph;
	head: RepoGraph;
	baseById: Map<SymbolId, CodeSymbol>;
	headById: Map<SymbolId, CodeSymbol>;
}) {
	const { base, head, baseById, headById } = input;
	const changes: SymbolChange[] = [];
	const removed = base.symbols.filter((symbol) => !headById.has(symbol.id));
	const added = head.symbols.filter((symbol) => !baseById.has(symbol.id));
	for (const symbol of head.symbols) {
		const before = baseById.get(symbol.id);
		if (before && before.bodyHash !== symbol.bodyHash) {
			changes.push({
				kind: "modified",
				base: symbol.id,
				head: symbol.id,
				signatureChanged: before.signatureHash !== symbol.signatureHash,
			});
		}
	}
	const moves = pairMoves(removed, added);
	const movedBase = new Set(moves.map((pair) => pair.base.id));
	const movedHead = new Set(moves.map((pair) => pair.head.id));
	for (const symbol of removed) {
		if (!movedBase.has(symbol.id)) changes.push({ kind: "removed", base: symbol.id });
	}
	for (const symbol of added) {
		if (!movedHead.has(symbol.id)) changes.push({ kind: "added", head: symbol.id });
	}
	const moved: SymbolChange[] = moves.map(({ base: from, head: to }) => ({
		kind: "moved",
		base: from.id,
		head: to.id,
	}));
	return { changes, moved, moves };
}

function changeIds(change: SymbolChange) {
	if (change.kind === "added") return [change.head];
	if (change.kind === "removed") return [change.base];
	return [change.base, change.head];
}

function edgeKey(edge: Pick<Edge, "from" | "to" | "kind" | "label">) {
	return `${edge.from}\0${edge.to}\0${edge.kind}\0${edge.label ?? ""}`;
}

function diffEdges(input: {
	base: RepoGraph;
	head: RepoGraph;
	moved: ReadonlyMap<SymbolId, SymbolId>;
}) {
	const { base, head, moved } = input;
	const translated = (edge: Edge) => ({
		...edge,
		from: moved.get(edge.from) ?? edge.from,
		to: moved.get(edge.to) ?? edge.to,
	});
	const baseKeys = new Map(base.edges.map((edge) => [edgeKey(translated(edge)), edge]));
	const headKeys = new Map(head.edges.map((edge) => [edgeKey(edge), edge]));
	const changes: EdgeChange[] = [];
	for (const [key, edge] of headKeys) {
		if (!baseKeys.has(key)) changes.push({ kind: "added", edge });
	}
	for (const [key, edge] of baseKeys) {
		if (!headKeys.has(key)) changes.push({ kind: "removed", edge });
	}
	return changes;
}

function createUnion(ids: Iterable<SymbolId>) {
	const parent = new Map<SymbolId, SymbolId>();
	for (const id of ids) parent.set(id, id);
	const find = (id: SymbolId): SymbolId => {
		const up = parent.get(id);
		if (up === undefined || up === id) return id;
		const top = find(up);
		parent.set(id, top);
		return top;
	};
	const join = (a: SymbolId, b: SymbolId) => {
		if (!parent.has(a) || !parent.has(b)) return;
		const left = find(a);
		const right = find(b);
		if (left !== right) parent.set(right, left);
	};
	return { find, join };
}

function groupChanges(input: {
	changes: readonly SymbolChange[];
	base: RepoGraph;
	head: RepoGraph;
	baseById: Map<SymbolId, CodeSymbol>;
	headById: Map<SymbolId, CodeSymbol>;
}) {
	const { changes, base, head, baseById, headById } = input;
	const ids = new Set(changes.flatMap(changeIds));
	const union = createUnion(ids);
	for (const graph of [head, base]) {
		for (const edge of graph.edges) {
			if (GROUP_EDGES.has(edge.kind)) union.join(edge.from, edge.to);
		}
	}
	for (const id of ids) {
		const symbol = headById.get(id) ?? baseById.get(id);
		if (symbol?.parent) union.join(id, symbol.parent);
	}
	const groups = new Map<SymbolId, SymbolChange[]>();
	for (const change of changes) {
		const [first] = changeIds(change);
		if (first === undefined) continue;
		const key = union.find(first);
		const list = groups.get(key) ?? [];
		list.push(change);
		groups.set(key, list);
	}
	return [...groups.values()];
}

function highestSymbol(input: {
	changes: readonly SymbolChange[];
	base: RepoGraph;
	head: RepoGraph;
	baseById: Map<SymbolId, CodeSymbol>;
	headById: Map<SymbolId, CodeSymbol>;
}) {
	const { changes, base, head, baseById, headById } = input;
	const ids = new Set(changes.flatMap(changeIds));
	const calledBy = new Map<SymbolId, number>();
	const calls = new Map<SymbolId, number>();
	for (const graph of [head, base]) {
		for (const edge of graph.edges) {
			if (!GROUP_EDGES.has(edge.kind) || !ids.has(edge.from) || !ids.has(edge.to)) continue;
			calledBy.set(edge.to, (calledBy.get(edge.to) ?? 0) + 1);
			calls.set(edge.from, (calls.get(edge.from) ?? 0) + 1);
		}
	}
	const ranked = [...ids]
		.map((id) => headById.get(id) ?? baseById.get(id))
		.filter((symbol) => symbol !== undefined)
		.sort(
			(a, b) =>
				(calledBy.get(a.id) ?? 0) - (calledBy.get(b.id) ?? 0) ||
				Number(a.isTest) - Number(b.isTest) ||
				Number(a.kind === "module") - Number(b.kind === "module") ||
				(calls.get(b.id) ?? 0) - (calls.get(a.id) ?? 0) ||
				compareText(a.id, b.id),
		);
	return ranked[0];
}

function groupTitle(symbol: CodeSymbol) {
	return symbol.kind === "module" ? symbol.file : symbol.name;
}

function buildGroup(input: {
	changes: SymbolChange[];
	edgeChanges: readonly EdgeChange[];
	base: RepoGraph;
	head: RepoGraph;
	baseById: Map<SymbolId, CodeSymbol>;
	headById: Map<SymbolId, CodeSymbol>;
	headIndex: CallerIndex;
	baseIndex: CallerIndex;
	blastLimit: number | undefined;
}) {
	const { changes, edgeChanges, headIndex, baseIndex, blastLimit } = input;
	const limit = blastLimit === undefined ? {} : { limit: blastLimit };
	const ids = new Set(changes.flatMap(changeIds));
	const headSeeds = changes.flatMap((change) => (change.kind === "removed" ? [] : [change.head]));
	const baseSeeds = changes.flatMap((change) => (change.kind === "removed" ? [change.base] : []));
	const blast = mergeBlast(
		blastRadius({ index: headIndex, seeds: headSeeds, ...limit }),
		blastRadius({ index: baseIndex, seeds: baseSeeds, ...limit }),
	);
	const top = highestSymbol({ ...input, changes });
	const sortedIds = [...ids].sort(compareText);
	const group: ChangeGroup = {
		id: `group-${Bun.hash(sortedIds.join("\0")).toString(36)}`,
		title: top ? groupTitle(top) : "Other changes",
		symbolChanges: changes,
		edgeChanges: edgeChanges.filter(
			(change) => ids.has(change.edge.from) || ids.has(change.edge.to),
		),
		blast,
	};
	return group;
}

function orphanEdgeGroup(
	edgeChanges: readonly EdgeChange[],
	groups: readonly ChangeGroup[],
): ChangeGroup | undefined {
	const covered = new Set(
		groups.flatMap((group) => group.edgeChanges.map((change) => edgeKey(change.edge))),
	);
	const orphans = edgeChanges.filter(
		(change) => !covered.has(edgeKey(change.edge)) && change.edge.kind !== "type-ref",
	);
	if (orphans.length === 0) return undefined;
	return {
		id: "group-wiring",
		title: "Wiring changes",
		symbolChanges: [],
		edgeChanges: orphans,
		blast: { callers: [], entryPoints: [], tests: [], truncated: false },
	};
}

function isTopLevelExport(symbol: CodeSymbol) {
	return symbol.barrelExported && !symbol.parent && symbol.kind !== "module";
}

function diffContracts(input: {
	base: RepoGraph;
	head: RepoGraph;
	baseById: Map<SymbolId, CodeSymbol>;
	headById: Map<SymbolId, CodeSymbol>;
	moved: ReadonlyMap<SymbolId, SymbolId>;
}) {
	const { base, head, baseById, headById, moved } = input;
	const contracts: ContractChange[] = [];
	const movedTargets = new Set(moved.values());
	for (const symbol of head.symbols) {
		const before = baseById.get(symbol.id);
		if (isTopLevelExport(symbol) && !before?.barrelExported && !movedTargets.has(symbol.id)) {
			contracts.push({ kind: "export-added", symbol: symbol.id });
		}
		if (before && symbol.barrelExported && before.signatureHash !== symbol.signatureHash) {
			contracts.push({
				kind: "signature-changed",
				symbol: symbol.id,
				before: before.signature,
				after: symbol.signature,
			});
		}
	}
	for (const symbol of base.symbols) {
		if (!isTopLevelExport(symbol) || moved.has(symbol.id)) continue;
		if (!headById.get(symbol.id)?.barrelExported) {
			contracts.push({ kind: "export-removed", symbol: symbol.id });
		}
	}
	const methodsOf = (graph: RepoGraph) =>
		new Set(graph.symbols.filter((s) => s.kind === "wire-handler").map((s) => s.name));
	const baseMethods = methodsOf(base);
	const headMethods = methodsOf(head);
	for (const method of [...headMethods].sort()) {
		if (!baseMethods.has(method)) contracts.push({ kind: "wire-method-added", method });
	}
	for (const method of [...baseMethods].sort()) {
		if (!headMethods.has(method)) contracts.push({ kind: "wire-method-removed", method });
	}
	const moduleKeys = (graph: RepoGraph) =>
		new Map(graph.moduleEdges.map((edge) => [`${edge.from}\0${edge.to}`, edge]));
	const baseModules = moduleKeys(base);
	const headModules = moduleKeys(head);
	for (const [key, edge] of headModules) {
		if (!baseModules.has(key)) {
			contracts.push({ kind: "module-dependency-added", from: edge.from, to: edge.to });
		}
	}
	for (const [key, edge] of baseModules) {
		if (!headModules.has(key)) {
			contracts.push({ kind: "module-dependency-removed", from: edge.from, to: edge.to });
		}
	}
	return contracts;
}

function diffFiles(input: {
	base: RepoGraph;
	head: RepoGraph;
	changes: readonly SymbolChange[];
	moved: readonly SymbolChange[];
	baseById: Map<SymbolId, CodeSymbol>;
	headById: Map<SymbolId, CodeSymbol>;
}) {
	const { base, head, changes, moved, baseById, headById } = input;
	const baseFiles = new Map(base.files.map((file) => [file.path, file]));
	const headFiles = new Map(head.files.map((file) => [file.path, file]));
	const changed = new Set<string>();
	const candidates: string[] = [];
	for (const [path, file] of headFiles) {
		const before = baseFiles.get(path);
		if (!before) changed.add(path);
		else if (before.contentHash !== file.contentHash) {
			changed.add(path);
			if (before.tokenHash === file.tokenHash) candidates.push(path);
		}
	}
	for (const path of baseFiles.keys()) {
		if (!headFiles.has(path)) changed.add(path);
	}
	const symbolFiles = new Set<string>();
	for (const change of [...changes, ...moved]) {
		for (const id of changeIds(change)) {
			const symbol = headById.get(id) ?? baseById.get(id);
			if (symbol) symbolFiles.add(symbol.file);
		}
	}
	return {
		changedFiles: [...changed].sort(compareText),
		formatOnlyFiles: candidates.filter((path) => !symbolFiles.has(path)).sort(compareText),
	};
}

export function diffGraphs(input: DiffInput) {
	const { base, head, blastLimit } = input;
	const baseById = byId(base);
	const headById = byId(head);
	const { changes, moved, moves } = classifySymbols({ base, head, baseById, headById });
	const movedMap = new Map(moves.map((pair) => [pair.base.id, pair.head.id]));
	const edgeChanges = diffEdges({ base, head, moved: movedMap });
	const headIndex = buildCallerIndex(head);
	const baseIndex = buildCallerIndex(base);
	const shared = { base, head, baseById, headById };
	const groups = groupChanges({ ...shared, changes })
		.map((group) =>
			buildGroup({ ...shared, changes: group, edgeChanges, headIndex, baseIndex, blastLimit }),
		)
		.sort(
			(a, b) =>
				b.symbolChanges.length - a.symbolChanges.length ||
				b.blast.callers.length - a.blast.callers.length ||
				compareText(a.title, b.title) ||
				compareText(a.id, b.id),
		);
	const wiring = orphanEdgeGroup(edgeChanges, groups);
	const diff: GraphDiff = {
		groups: wiring ? [...groups, wiring] : groups,
		contracts: diffContracts({ ...shared, moved: movedMap }),
		movedOnly: moved,
		...diffFiles({ ...shared, changes, moved }),
		nonCodeFiles: [...(input.nonCodeFiles ?? [])].sort(compareText),
	};
	return diff;
}
