import { describe, expect, test } from "bun:test";
import type { ChangeGroup, GraphDiff } from "../../core/types";
import {
	bucketContracts,
	buildDiffIndex,
	buildGroupGraph,
	changeCounts,
	defaultFocus,
	FULL_GROUP_LIMIT,
	groupByModule,
	hasCodeChanges,
	signatureDelta,
} from "./changes";
import { makeEdge, makeGraph, makeSymbol } from "./fixture";
import { buildGraphIndex } from "./graphIndex";

const kept = makeSymbol({ file: "a/k.ts", name: "kept" });
const added = makeSymbol({ file: "a/n.ts", name: "fresh" });
const gone = makeSymbol({ file: "a/o.ts", name: "gone" });
const callerOf = makeSymbol({ file: "a/c.ts", name: "caller" });
const movedBase = makeSymbol({ file: "a/old.ts", name: "mover" });
const movedHead = makeSymbol({ file: "a/new.ts", name: "mover" });

const head = buildGraphIndex(
	makeGraph({
		symbols: [kept, added, callerOf, movedHead],
		edges: [
			makeEdge({ from: callerOf.id, to: kept.id }),
			makeEdge({ from: kept.id, to: added.id }),
		],
	}),
);
const base = buildGraphIndex(
	makeGraph({
		symbols: [kept, gone, callerOf, movedBase],
		edges: [makeEdge({ from: callerOf.id, to: kept.id }), makeEdge({ from: kept.id, to: gone.id })],
	}),
);

const group: ChangeGroup = {
	id: "g",
	title: "kept",
	symbolChanges: [
		{ kind: "modified", base: kept.id, head: kept.id, signatureChanged: true },
		{ kind: "added", head: added.id },
		{ kind: "removed", base: gone.id },
		{ kind: "moved", base: movedBase.id, head: movedHead.id },
	],
	edgeChanges: [
		{ kind: "added", edge: makeEdge({ from: kept.id, to: added.id }) },
		{ kind: "removed", edge: makeEdge({ from: kept.id, to: gone.id }) },
		{ kind: "removed", edge: makeEdge({ from: movedBase.id, to: gone.id }) },
	],
	blast: { callers: [], entryPoints: [], tests: [], truncated: false },
};

const diff: GraphDiff = {
	groups: [group],
	contracts: [],
	movedOnly: [],
	formatOnlyFiles: [],
	changedFiles: [],
	nonCodeFiles: [],
};
const diffIndex = buildDiffIndex(diff);

describe("buildGroupGraph", () => {
	const graph = buildGroupGraph({ group, diffIndex, head, base });
	const statusOf = (id: string) => graph.nodes.find((node) => node.id === id)?.status;

	test("marks each node with its change state", () => {
		expect(statusOf(kept.id)).toBe("modified");
		expect(statusOf(added.id)).toBe("added");
		expect(statusOf(gone.id)).toBe("removed");
		expect(statusOf(movedHead.id)).toBe("moved");
	});

	test("reads removed symbols from the base graph", () => {
		expect(graph.nodes.find((node) => node.id === gone.id)?.side).toBe("base");
	});

	test("marks added and removed edges", () => {
		const status = (from: string, to: string) =>
			graph.edges.find((edge) => edge.from === from && edge.to === to)?.status;
		expect(status(kept.id, added.id)).toBe("added");
		expect(status(kept.id, gone.id)).toBe("removed");
	});

	test("maps moved base ids to head ids so an edge stays connected", () => {
		expect(graph.edges.some((edge) => edge.from === movedHead.id && edge.to === gone.id)).toBe(
			true,
		);
	});

	test("shows an unchanged caller only as a muted neighbor", () => {
		const lone: ChangeGroup = {
			...group,
			symbolChanges: [{ kind: "modified", base: kept.id, head: kept.id, signatureChanged: false }],
			edgeChanges: [],
		};
		const result = buildGroupGraph({
			group: lone,
			diffIndex: buildDiffIndex({ ...diff, groups: [lone] }),
			head,
			base,
		});
		expect(result.nodes.find((node) => node.id === callerOf.id)?.status).toBe("neighbor");
	});

	test("focuses a large group around one symbol", () => {
		const many = Array.from({ length: FULL_GROUP_LIMIT + 10 }, (_, position) =>
			makeSymbol({ file: "b/m.ts", name: `s${position}` }),
		);
		const hub = many[0];
		if (!hub) throw new Error("expected a hub");
		const large: ChangeGroup = {
			...group,
			symbolChanges: many.map((symbol) => ({ kind: "added", head: symbol.id })),
			edgeChanges: many
				.slice(1, 4)
				.map((symbol) => ({ kind: "added", edge: makeEdge({ from: hub.id, to: symbol.id }) })),
		};
		const largeIndex = buildDiffIndex({ ...diff, groups: [large] });
		const largeHead = buildGraphIndex(makeGraph({ symbols: many }));
		expect(defaultFocus({ group: large, diffIndex: largeIndex })).toBe(hub.id);
		const result = buildGroupGraph({
			group: large,
			diffIndex: largeIndex,
			head: largeHead,
			base,
			focus: hub.id,
		});
		expect(result.focused).toBe(true);
		expect(result.nodes).toHaveLength(4);
		expect(result.totalChanged).toBe(many.length);
	});
});

describe("diff helpers", () => {
	test("counts changes by kind", () => {
		expect(changeCounts(group.symbolChanges)).toEqual({
			added: 1,
			removed: 1,
			modified: 1,
			moved: 1,
		});
	});

	test("buckets contracts", () => {
		const buckets = bucketContracts([
			{ kind: "export-added", symbol: kept.id },
			{ kind: "signature-changed", symbol: kept.id, before: "a", after: "b" },
			{ kind: "wire-method-removed", method: "m" },
			{ kind: "module-dependency-added", from: "a", to: "b" },
		]);
		expect([
			buckets.exports.length,
			buckets.signatures.length,
			buckets.wire.length,
			buckets.modules.length,
		]).toEqual([1, 1, 1, 1]);
	});

	test("orders module groups by size", () => {
		const groups = groupByModule([{ module: "a" }, { module: "b" }, { module: "b" }]);
		expect(groups.map((entry) => entry.module)).toEqual(["b", "a"]);
	});

	test("reports when a diff has no code changes", () => {
		expect(hasCodeChanges(diff)).toBe(true);
		expect(hasCodeChanges({ ...diff, groups: [] })).toBe(false);
	});

	test("signatureDelta isolates the changed words and trims the rest", () => {
		const lead = "a ".repeat(100);
		const delta = signatureDelta({
			before: `${lead}string end`,
			after: `${lead}number end`,
			context: 4,
		});
		expect(delta.before.filter((part) => part.changed).map((part) => part.text)).toEqual([
			"string",
		]);
		expect(delta.after.filter((part) => part.changed).map((part) => part.text)).toEqual(["number"]);
		expect(delta.before[0]?.text.startsWith("...")).toBe(true);
		expect(signatureDelta({ before: "same", after: "same" }).same).toBe(true);
	});
});
