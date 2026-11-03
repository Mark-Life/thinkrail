import { describe, expect, test } from "bun:test";
import type { FileInfo, ModuleInfo } from "../../core/types";
import {
	breadcrumb,
	buildMapTree,
	findNode,
	heatLegend,
	heatOf,
	heatStep,
	squarify,
} from "./treemap";

function file(
	path: string,
	module: string,
	lines: number,
	extra: Partial<FileInfo> = {},
): FileInfo {
	return {
		path,
		module,
		lines,
		isTest: false,
		commits90d: 0,
		imports: [],
		contentHash: "",
		tokenHash: "",
		...extra,
	};
}

function module(path: string): ModuleInfo {
	return { path, lines: 0, files: 0 };
}

const modules = [
	module("apps/web"),
	module("apps/web/src/chat"),
	module("packages/server"),
	module("."),
];
const files = [
	file("apps/web/main.ts", "apps/web", 10, { commits90d: 2 }),
	file("apps/web/src/chat/a.ts", "apps/web/src/chat", 30, { commits90d: 4 }),
	file("apps/web/src/chat/a.test.ts", "apps/web/src/chat", 50, { isTest: true }),
	file("packages/server/s.ts", "packages/server", 60),
	file("README.ts", ".", 5),
];

describe("buildMapTree", () => {
	const { root } = buildMapTree({ files, modules, includeTests: false });

	test("nests modules, rolls up lines and hides tests", () => {
		const web = findNode(root, "apps/web");
		expect(web?.lines).toBe(40);
		expect(findNode(root, "apps/web/src/chat")?.children.map((child) => child.label)).toEqual([
			"a.ts",
		]);
		expect(root.lines).toBe(105);
	});

	test("includes tests when asked", () => {
		const withTests = buildMapTree({ files, modules, includeTests: true }).root;
		expect(findNode(withTests, "apps/web")?.lines).toBe(90);
	});

	test("drops modules that end up empty", () => {
		const { root: bare } = buildMapTree({
			files: [file("x/a.test.ts", "x", 3, { isTest: true })],
			modules: [module("x")],
			includeTests: false,
		});
		expect(bare.children).toEqual([]);
	});

	test("weights heat by lines", () => {
		const web = findNode(root, "apps/web");
		expect(web && heatOf(web)).toBeCloseTo((10 * 2 + 30 * 4) / 40);
	});

	test("breadcrumb walks down from the root", () => {
		expect(breadcrumb(root, "apps/web/src/chat").map((node) => node.path)).toEqual([
			"",
			"apps/web",
			"apps/web/src/chat",
		]);
	});
});

describe("heat", () => {
	test("steps cover the legend", () => {
		expect(heatStep(0)).toBe(0);
		expect(heatStep(1.5)).toBe(2 - 1);
		expect(heatStep(100)).toBe(6);
		expect(heatLegend().map((entry) => entry.label)).toEqual([
			"0",
			"1",
			"2-3",
			"4-7",
			"8-15",
			"16-31",
			"32+",
		]);
	});
});

describe("squarify", () => {
	const rect = { x: 0, y: 0, width: 400, height: 300 };
	const items = [600, 300, 200, 100, 50, 25, 5, 5].map((value, id) => ({ id, value }));
	const tiles = squarify({ items, value: (item) => item.value, rect });

	test("fills the rectangle with areas proportional to values", () => {
		const total = items.reduce((sum, item) => sum + item.value, 0);
		for (const tile of tiles) {
			expect(tile.width * tile.height).toBeCloseTo((tile.item.value / total) * 400 * 300, 3);
		}
	});

	test("keeps tiles inside the rectangle without overlaps", () => {
		for (const [position, tile] of tiles.entries()) {
			expect(tile.x).toBeGreaterThanOrEqual(-0.001);
			expect(tile.y).toBeGreaterThanOrEqual(-0.001);
			expect(tile.x + tile.width).toBeLessThanOrEqual(400.001);
			expect(tile.y + tile.height).toBeLessThanOrEqual(300.001);
			for (const other of tiles.slice(position + 1)) {
				const apart =
					tile.x + tile.width <= other.x + 0.001 ||
					other.x + other.width <= tile.x + 0.001 ||
					tile.y + tile.height <= other.y + 0.001 ||
					other.y + other.height <= tile.y + 0.001;
				expect(apart).toBe(true);
			}
		}
	});

	test("produces tiles closer to squares than a slice layout", () => {
		const worst = Math.max(
			...tiles.map((tile) => Math.max(tile.width / tile.height, tile.height / tile.width)),
		);
		expect(worst).toBeLessThan(4);
	});

	test("skips zero values and a zero-size rectangle", () => {
		expect(squarify({ items: [0], value: (item) => item, rect })).toEqual([]);
		expect(squarify({ items: [1], value: (item) => item, rect: { ...rect, width: 0 } })).toEqual(
			[],
		);
	});
});
