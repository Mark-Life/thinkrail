import { describe, expect, test } from "bun:test";
import { makeEdge, makeGraph, makeSymbol, sid } from "./fixture";
import { buildGraphIndex } from "./graphIndex";
import {
	buildTrace,
	FAN_OUT_LIMIT,
	moreKey,
	type TraceMoreNode,
	type TraceSymbolNode,
} from "./trace";

const web = makeSymbol({ file: "apps/web/a.ts", name: "send" });
const handler = makeSymbol({
	file: "packages/server/h.ts",
	name: "session.prompt",
	kind: "wire-handler",
});
const impl = makeSymbol({ file: "packages/server/s.ts", name: "run" });
const deep = makeSymbol({ file: "packages/server/s.ts", name: "deep" });
const type = makeSymbol({ file: "packages/contracts/t.ts", name: "Thing", kind: "interface" });
const test1 = makeSymbol({ file: "apps/web/a.test.ts", name: "case", isTest: true });

const graph = makeGraph({
	symbols: [web, handler, impl, deep, type, test1],
	edges: [
		makeEdge({ from: web.id, to: handler.id, kind: "wire-request", label: "session.prompt" }),
		makeEdge({ from: handler.id, to: impl.id }),
		makeEdge({ from: impl.id, to: deep.id }),
		makeEdge({ from: handler.id, to: type.id, kind: "type-ref" }),
		makeEdge({ from: test1.id, to: handler.id }),
	],
});
const index = buildGraphIndex(graph);

function trace(input: Partial<Parameters<typeof buildTrace>[0]> & { center: typeof web.id }) {
	const result = buildTrace({
		index,
		expanded: new Set(),
		revealed: new Set(),
		types: false,
		tests: false,
		...input,
	});
	if (!result) throw new Error("expected a trace");
	return result;
}

function layerOf(result: ReturnType<typeof trace>, id: string) {
	return result.nodes.find((node) => node.id === id)?.layer;
}

describe("buildTrace", () => {
	test("puts callers left and callees right, one level by default", () => {
		const result = trace({ center: handler.id });
		expect(layerOf(result, web.id)).toBe(-1);
		expect(layerOf(result, impl.id)).toBe(1);
		expect(layerOf(result, deep.id)).toBeUndefined();
		const callee = result.nodes.find((node) => node.id === impl.id) as TraceSymbolNode;
		expect(callee.hiddenNeighbors).toBe(1);
	});

	test("labels wire edges and marks them wide", () => {
		const edge = trace({ center: handler.id }).edges.find((item) => item.kind === "wire-request");
		expect(edge?.label).toBe("session.prompt");
		expect(edge?.wide).toBe(true);
	});

	test("expands a node by id", () => {
		const result = trace({ center: handler.id, expanded: new Set([impl.id]) });
		expect(layerOf(result, deep.id)).toBe(2);
	});

	test("hides type-ref and tests by default and counts them", () => {
		const hidden = trace({ center: handler.id });
		expect(layerOf(hidden, type.id)).toBeUndefined();
		expect(layerOf(hidden, test1.id)).toBeUndefined();
		expect(hidden.hiddenTypeRefs).toBe(1);
		expect(hidden.hiddenTests).toBe(1);
		const shown = trace({ center: handler.id, types: true, tests: true });
		expect(layerOf(shown, type.id)).toBe(1);
		expect(layerOf(shown, test1.id)).toBe(-1);
	});

	test("always shows type-ref when the center is a type", () => {
		const result = trace({ center: type.id });
		expect(result.typesForced).toBe(true);
		expect(layerOf(result, handler.id)).toBe(-1);
	});

	test("collapses high fan-out with a more node, wire edges first", () => {
		const hub = makeSymbol({ file: "x/h.ts", name: "hub" });
		const callers = Array.from({ length: FAN_OUT_LIMIT + 5 }, (_, position) =>
			makeSymbol({ file: "x/c.ts", name: `c${position}` }),
		);
		const wireCaller = makeSymbol({ file: "y/w.ts", name: "zz" });
		const wide = buildGraphIndex(
			makeGraph({
				symbols: [hub, wireCaller, ...callers],
				edges: [
					...callers.map((caller) => makeEdge({ from: caller.id, to: hub.id })),
					makeEdge({ from: wireCaller.id, to: hub.id, kind: "wire-request", label: "m" }),
				],
			}),
		);
		const result = buildTrace({
			index: wide,
			center: hub.id,
			expanded: new Set(),
			revealed: new Set(),
			types: false,
			tests: false,
		});
		const more = result?.nodes.find((node) => node.type === "more") as TraceMoreNode;
		expect(more.hidden).toBe(6);
		expect(result?.nodes.some((node) => node.id === wireCaller.id)).toBe(true);
		const revealed = buildTrace({
			index: wide,
			center: hub.id,
			expanded: new Set(),
			revealed: new Set([moreKey("caller", hub.id)]),
			types: false,
			tests: false,
		});
		expect(revealed?.nodes.some((node) => node.type === "more")).toBe(false);
	});

	test("continues through implements from member to implementation", () => {
		const member = makeSymbol({ file: "x/i.ts", name: "T.run", kind: "method" });
		const concrete = makeSymbol({ file: "x/c.ts", name: "make.run", kind: "method" });
		const caller = makeSymbol({ file: "x/u.ts", name: "use" });
		const result = buildTrace({
			index: buildGraphIndex(
				makeGraph({
					symbols: [member, concrete, caller],
					edges: [
						makeEdge({ from: caller.id, to: member.id }),
						makeEdge({ from: concrete.id, to: member.id, kind: "implements" }),
					],
				}),
			),
			center: member.id,
			expanded: new Set(),
			revealed: new Set(),
			types: false,
			tests: false,
		});
		const edge = result?.edges.find((item) => item.kind === "implements");
		expect(edge?.from).toBe(member.id);
		expect(edge?.to).toBe(concrete.id);
		expect(edge?.label).toBe("impl");
	});

	test("returns undefined for an unknown center and survives a cycle", () => {
		expect(
			buildTrace({
				index,
				center: sid("no", "pe"),
				expanded: new Set(),
				revealed: new Set(),
				types: false,
				tests: false,
			}),
		).toBeUndefined();
		const a = makeSymbol({ file: "x/a.ts", name: "a" });
		const b = makeSymbol({ file: "x/a.ts", name: "b" });
		const cyclic = buildGraphIndex(
			makeGraph({
				symbols: [a, b],
				edges: [makeEdge({ from: a.id, to: b.id }), makeEdge({ from: b.id, to: a.id })],
			}),
		);
		const result = buildTrace({
			index: cyclic,
			center: a.id,
			expanded: new Set([b.id]),
			revealed: new Set(),
			types: false,
			tests: false,
		});
		expect(result?.nodes).toHaveLength(2);
	});
});
