import { describe, expect, test } from "bun:test";
import { makeEdge, makeGraph, makeSymbol } from "./fixture";
import { buildFlow, UTILITY_FAN_IN } from "./flow";
import { buildGraphIndex } from "./graphIndex";

const root = makeSymbol({ file: "apps/web/root.ts", name: "root" });
const first = makeSymbol({ file: "apps/web/a.ts", name: "first" });
const second = makeSymbol({ file: "packages/server/b.ts", name: "second", kind: "wire-handler" });
const leaf = makeSymbol({ file: "packages/server/c.ts", name: "leaf" });

const index = buildGraphIndex(
	makeGraph({
		symbols: [root, first, second, leaf],
		edges: [
			makeEdge({ from: root.id, to: second.id, kind: "wire-request", line: 20, label: "m.call" }),
			makeEdge({ from: root.id, to: first.id, line: 10 }),
			makeEdge({ from: second.id, to: leaf.id, line: 5 }),
			makeEdge({ from: first.id, to: leaf.id, line: 3 }),
			makeEdge({ from: leaf.id, to: root.id, line: 9 }),
		],
	}),
);

describe("buildFlow", () => {
	test("walks depth-first in source-line order", () => {
		const flow = buildFlow({ index, root: root.id, depth: 3, utilities: true });
		expect(flow?.steps.map((step) => step.to.name)).toEqual([
			"first",
			"leaf",
			"root",
			"second",
			"leaf",
		]);
	});

	test("makes one lane per module and marks wire crossings", () => {
		const flow = buildFlow({ index, root: root.id, depth: 1, utilities: true });
		expect(flow?.lanes.map((lane) => lane.module)).toEqual(["apps/web", "packages/server"]);
		const wire = flow?.steps.find((step) => step.wire);
		expect(wire?.label).toBe("m.call");
		expect(wire?.toLane).toBe(1);
	});

	test("stops at the depth and marks repeats instead of looping", () => {
		const shallow = buildFlow({ index, root: root.id, depth: 1, utilities: true });
		expect(shallow?.steps).toHaveLength(2);
		const deep = buildFlow({ index, root: root.id, depth: 8, utilities: true });
		expect(deep?.steps.filter((step) => step.repeated).map((step) => step.to.name)).toEqual([
			"root",
			"leaf",
		]);
	});

	test("records how far each expanded step reaches", () => {
		const flow = buildFlow({ index, root: root.id, depth: 3, utilities: true });
		expect(flow?.steps[0]?.endRow).toBe(2);
	});

	test("truncates at the step limit", () => {
		const flow = buildFlow({ index, root: root.id, depth: 8, utilities: true, maxSteps: 2 });
		expect(flow?.truncated).toBe(true);
		expect(flow?.steps).toHaveLength(2);
	});

	test("hides high fan-in utilities, never wire crossings", () => {
		const util = makeSymbol({ file: "x/u.ts", name: "cn" });
		const callers = Array.from({ length: UTILITY_FAN_IN }, (_, position) =>
			makeSymbol({ file: "x/c.ts", name: `c${position}` }),
		);
		const start = makeSymbol({ file: "x/s.ts", name: "start" });
		const busy = buildGraphIndex(
			makeGraph({
				symbols: [util, start, ...callers],
				edges: [
					makeEdge({ from: start.id, to: util.id }),
					...callers.map((caller) => makeEdge({ from: caller.id, to: util.id })),
				],
			}),
		);
		const hidden = buildFlow({ index: busy, root: start.id, depth: 2, utilities: false });
		expect(hidden?.steps).toHaveLength(0);
		expect(hidden?.hiddenUtilities).toBe(1);
		expect(
			buildFlow({ index: busy, root: start.id, depth: 2, utilities: true })?.steps,
		).toHaveLength(1);
	});

	test("folds a single implementation into the call", () => {
		const member = makeSymbol({ file: "x/i.ts", name: "T.run", kind: "method" });
		const concrete = makeSymbol({ file: "x/c.ts", name: "make.run", kind: "method" });
		const caller = makeSymbol({ file: "x/u.ts", name: "use" });
		const flow = buildFlow({
			index: buildGraphIndex(
				makeGraph({
					symbols: [member, concrete, caller],
					edges: [
						makeEdge({ from: caller.id, to: member.id }),
						makeEdge({ from: concrete.id, to: member.id, kind: "implements" }),
					],
				}),
			),
			root: caller.id,
			depth: 3,
			utilities: true,
		});
		expect(flow?.steps.map((step) => step.to.name)).toEqual(["make.run"]);
	});
});
