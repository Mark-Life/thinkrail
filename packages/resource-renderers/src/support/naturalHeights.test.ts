import { expect, test } from "bun:test";
import {
	forgetNaturalHeight,
	NATURAL_HEIGHT_LIMIT,
	naturalHeightKey,
	rememberedNaturalHeight,
	rememberNaturalHeight,
} from "./naturalHeights";

test("a natural height is remembered per workspace, path and comparison base", () => {
	const view = naturalHeightKey("w1", "mockups/a.html");
	const diff = naturalHeightKey("w1", "mockups/a.html", "mockups/old.html");
	rememberNaturalHeight(view, "html\u0000h1", 1662);
	expect(rememberedNaturalHeight(view)).toBe(1662);
	expect(rememberedNaturalHeight(diff)).toBeUndefined();
	expect(rememberedNaturalHeight(naturalHeightKey("w2", "mockups/a.html"))).toBeUndefined();
	forgetNaturalHeight(view);
	expect(rememberedNaturalHeight(view)).toBeUndefined();
});

test("a remembered height answers a stamp only when it was measured for that stamp", () => {
	const key = naturalHeightKey("w1", "mockups/stamped.html");
	rememberNaturalHeight(key, "html\u0000h1", 700);
	expect(rememberedNaturalHeight(key, "html\u0000h1")).toBe(700);
	expect(rememberedNaturalHeight(key, "html\u0000h2")).toBeUndefined();
	expect(rememberedNaturalHeight(key, "source\u0000h1")).toBeUndefined();
	rememberNaturalHeight(key, "html\u0000h2", 900);
	expect(rememberedNaturalHeight(key, "html\u0000h2")).toBe(900);
	forgetNaturalHeight(key);
});

test("the memory drops its oldest entry at the limit", () => {
	const keys = Array.from({ length: NATURAL_HEIGHT_LIMIT + 1 }, (_, index) =>
		naturalHeightKey("limit", `mockups/${index}.html`),
	);
	const [first = "", second = ""] = keys;
	for (const key of keys.slice(0, NATURAL_HEIGHT_LIMIT)) rememberNaturalHeight(key, "s", 300);
	rememberNaturalHeight(first, "s", 301);
	rememberNaturalHeight(keys.at(-1) ?? "", "s", 300);
	expect(rememberedNaturalHeight(first)).toBe(301);
	expect(rememberedNaturalHeight(second)).toBeUndefined();
	expect(rememberedNaturalHeight(keys.at(-1) ?? "")).toBe(300);
	for (const key of keys) forgetNaturalHeight(key);
});
