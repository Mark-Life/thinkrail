import { describe, expect, test } from "bun:test";
import { nearestInDirection } from "./navigation";

const nodes = [
	{ id: "left", layer: -1, y: 100, height: 40 },
	{ id: "center", layer: 0, y: 100, height: 40 },
	{ id: "below", layer: 0, y: 200, height: 40 },
	{ id: "top", layer: 1, y: 0, height: 40 },
	{ id: "bottom", layer: 1, y: 180, height: 40 },
	{ id: "far", layer: 3, y: 180, height: 40 },
];

describe("nearestInDirection", () => {
	test("moves to the closest node in the next layer", () => {
		expect(nearestInDirection({ nodes, from: "center", direction: "right" })).toBe("bottom");
		expect(nearestInDirection({ nodes, from: "center", direction: "left" })).toBe("left");
	});

	test("moves inside a layer", () => {
		expect(nearestInDirection({ nodes, from: "center", direction: "down" })).toBe("below");
		expect(nearestInDirection({ nodes, from: "center", direction: "up" })).toBeUndefined();
	});

	test("skips empty layers and stops at the edge", () => {
		expect(nearestInDirection({ nodes, from: "bottom", direction: "right" })).toBe("far");
		expect(nearestInDirection({ nodes, from: "left", direction: "left" })).toBeUndefined();
	});
});
