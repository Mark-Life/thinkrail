import { expect, test } from "bun:test";
import { compile, int, obj, str } from "@earendil-works/pi-schema";
import { LayoutPresetCenterNode } from "./settings";
import { narrowed } from "./wire";

test("a recursive schema checks its nodes at every depth", () => {
	const validator = compile(LayoutPresetCenterNode);
	const group = (id: string) => ({ kind: "group", id });
	const split = (children: [object, object]) => ({
		kind: "split",
		id: "s",
		direction: "horizontal",
		weights: [1, 1],
		children,
	});
	const deep = (leaf: object) => split([group("a"), split([group("b"), leaf])]);
	expect(validator.errors(deep(group("c")))).toEqual([]);
	expect(validator.errors(deep({ kind: "tabs", id: "c" }))).not.toEqual([]);
});

test("narrowing a narrowed schema keeps both rules", () => {
	const once = narrowed(obj({ name: str(), size: int() }), {
		properties: { name: { minLength: 1 } },
	});
	const twice = compile(narrowed(once, { properties: { size: { minimum: 1 } } }));
	expect(twice.check({ name: "a", size: 1 })).toBe(true);
	expect(twice.check({ name: "", size: 1 })).toBe(false);
	expect(twice.check({ name: "a", size: 0 })).toBe(false);
});
