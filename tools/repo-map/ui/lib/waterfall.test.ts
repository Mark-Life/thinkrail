import { describe, expect, test } from "bun:test";
import { makeEdge, makeGraph, makeSymbol } from "./fixture";
import { buildFlow } from "./flow";
import { buildGraphIndex } from "./graphIndex";
import { buildWaterfall, visibleWaterfallRows } from "./waterfall";

const root = makeSymbol({ file: "apps/web/root.ts", name: "root" });
const parent = makeSymbol({ file: "apps/web/parent.ts", name: "parent" });
const child = makeSymbol({ file: "apps/web/child.ts", name: "child" });
const grandchild = makeSymbol({ file: "apps/web/grandchild.ts", name: "grandchild" });
const sibling = makeSymbol({ file: "packages/server/sibling.ts", name: "sibling" });

const index = buildGraphIndex(
	makeGraph({
		symbols: [root, parent, child, grandchild, sibling],
		edges: [
			makeEdge({ from: root.id, to: parent.id, line: 1 }),
			makeEdge({ from: root.id, to: sibling.id, line: 2 }),
			makeEdge({ from: parent.id, to: child.id, line: 1 }),
			makeEdge({ from: child.id, to: grandchild.id, line: 1 }),
		],
	}),
);

function waterfall() {
	const flow = buildFlow({ index, root: root.id, depth: 5, utilities: true });
	if (!flow) throw new Error("flow missing");
	return buildWaterfall(flow);
}

describe("buildWaterfall", () => {
	test("adds the root and nests each bar inside its parent", () => {
		const { rows, total } = waterfall();
		expect(total).toBe(5);
		expect(rows.map((row) => [row.symbol.name, row.depth, row.start, row.span])).toEqual([
			["root", 0, 0, 5],
			["parent", 1, 1, 3],
			["child", 2, 2, 2],
			["grandchild", 3, 3, 1],
			["sibling", 1, 4, 1],
		]);
	});

	test("counts the calls inside each row", () => {
		expect(waterfall().rows.map((row) => row.callsInside)).toEqual([4, 2, 1, 0, 0]);
	});
});

describe("visibleWaterfallRows", () => {
	const names = (collapsed: number[]) =>
		visibleWaterfallRows({ rows: waterfall().rows, collapsed: new Set(collapsed) }).map(
			(row) => row.symbol.name,
		);

	test("shows every row when nothing is collapsed", () => {
		expect(names([])).toEqual(["root", "parent", "child", "grandchild", "sibling"]);
	});

	test("hides descendants and keeps the next sibling", () => {
		expect(names([1])).toEqual(["root", "parent", "sibling"]);
	});

	test("keeps an outer collapse when an inner row is collapsed too", () => {
		expect(names([1, 2])).toEqual(["root", "parent", "sibling"]);
	});

	test("collapsing the root leaves only the root", () => {
		expect(names([0])).toEqual(["root"]);
	});
});
