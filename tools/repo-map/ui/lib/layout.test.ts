import { describe, expect, test } from "bun:test";
import { assignLayers, countCrossings, layoutGraph, orderLayers, resolveOverlaps } from "./layout";

function node(id: string, layer: number, height = 48) {
	return { id, layer, width: 200, height };
}

function seededRandom(seed: number) {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

describe("assignLayers", () => {
	test("uses the shortest distance from the roots", () => {
		const layers = assignLayers({
			ids: ["a", "b", "c"],
			roots: ["a"],
			edges: [
				{ from: "a", to: "b" },
				{ from: "b", to: "c" },
				{ from: "a", to: "c" },
			],
		});
		expect([layers.get("a"), layers.get("b"), layers.get("c")]).toEqual([0, 1, 1]);
	});

	test("terminates on a cycle and places unreachable nodes", () => {
		const layers = assignLayers({
			ids: ["a", "b", "x"],
			roots: ["a"],
			edges: [
				{ from: "a", to: "b" },
				{ from: "b", to: "a" },
			],
		});
		expect(layers.get("b")).toBe(1);
		expect(layers.get("x")).toBe(0);
	});
});

describe("orderLayers", () => {
	test("removes a crossing that barycenter ordering can fix", () => {
		const nodes = [node("a", 0), node("b", 0), node("c", 1), node("d", 1)];
		const edges = [
			{ from: "a", to: "d" },
			{ from: "b", to: "c" },
		];
		expect(
			countCrossings({
				layers: [
					[0, nodes.slice(0, 2)],
					[1, nodes.slice(2)],
				],
				edges,
			}),
		).toBe(1);
		expect(countCrossings({ layers: orderLayers({ nodes, edges }), edges })).toBe(0);
	});
});

describe("resolveOverlaps", () => {
	test("keeps order and the minimum separation", () => {
		const centers = resolveOverlaps({ desired: [0, 0, 0], sizes: [10, 10, 10], gap: 2 });
		expect(centers[1] ?? 0).toBeCloseTo((centers[0] ?? 0) + 12);
		expect(centers[2] ?? 0).toBeCloseTo((centers[1] ?? 0) + 12);
	});

	test("does not move items that already fit", () => {
		expect(resolveOverlaps({ desired: [0, 100], sizes: [10, 10], gap: 2 })).toEqual([0, 100]);
	});
});

describe("layoutGraph", () => {
	test("never overlaps nodes on random graphs", () => {
		const random = seededRandom(7);
		for (let round = 0; round < 30; round++) {
			const nodes = Array.from({ length: 40 }, (_, index) =>
				node(`n${index}`, Math.floor(random() * 6) - 3, random() > 0.8 ? 30 : 48),
			);
			const edges = Array.from({ length: 80 }, () => ({
				from: `n${Math.floor(random() * 40)}`,
				to: `n${Math.floor(random() * 40)}`,
			}));
			const layout = layoutGraph({ nodes, edges });
			for (const [index, first] of layout.nodes.entries()) {
				for (const second of layout.nodes.slice(index + 1)) {
					const apartX =
						first.x + first.node.width <= second.x || second.x + second.node.width <= first.x;
					const apartY =
						first.y + first.node.height <= second.y || second.y + second.node.height <= first.y;
					expect(apartX || apartY).toBe(true);
				}
			}
		}
	});

	test("draws callers left of callees and widens a labelled gap", () => {
		const layout = layoutGraph({
			nodes: [node("web", -1), node("server", 0), node("db", 1)],
			edges: [
				{ from: "web", to: "server", label: "session.prompt", wide: true },
				{ from: "server", to: "db" },
			],
		});
		const x = (id: string) => layout.nodes.find((entry) => entry.node.id === id)?.x ?? 0;
		expect(x("web")).toBeLessThan(x("server"));
		expect(x("server") - x("web")).toBeGreaterThan(x("db") - x("server"));
		expect(layout.bands).toHaveLength(1);
		expect(layout.labels.map((label) => label.text)).toEqual(["session.prompt"]);
	});

	test("merges one label across edges to the same target and keeps labels apart", () => {
		const layout = layoutGraph({
			nodes: [node("a", 0), node("b", 0), node("x", 1), node("y", 1)],
			edges: [
				{ from: "a", to: "x", label: "m", wide: true },
				{ from: "b", to: "x", label: "m", wide: true },
				{ from: "a", to: "y", label: "n", wide: true },
			],
		});
		expect(layout.labels).toHaveLength(2);
		const [first, second] = [...layout.labels].sort((left, right) => left.y - right.y);
		expect((second?.y ?? 0) - (first?.y ?? 0)).toBeGreaterThanOrEqual(24);
	});

	test("routes same-layer and backward edges", () => {
		const layout = layoutGraph({
			nodes: [node("a", 0), node("b", 0), node("c", 1)],
			edges: [
				{ from: "a", to: "b" },
				{ from: "c", to: "a" },
			],
		});
		expect(layout.edges.map((edge) => edge.shape).sort()).toEqual(["back", "same"]);
	});

	test("handles an empty graph", () => {
		expect(layoutGraph({ nodes: [], edges: [] }).nodes).toEqual([]);
	});
});
