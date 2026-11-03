import { describe, expect, test } from "bun:test";
import { sid } from "./fixture";
import { DEFAULT_FLOW_DEPTH, formatHash, MAX_FLOW_DEPTH, parseHash, type Route } from "./route";

const fallback: Route = { view: "map", tests: false };
const symbol = sid("packages/server/src/host/handlers.ts", "handlers.session.prompt");

const routes: Route[] = [
	{ view: "map", tests: false },
	{ view: "map", tests: true, path: "apps/web/src/chat", file: "apps/web/src/chat/a b.ts" },
	{ view: "trace", side: "head", expanded: [], revealed: [], types: false, tests: false },
	{
		view: "trace",
		symbol,
		side: "base",
		expanded: [symbol, sid("a/b.ts", "c")],
		revealed: [`out:${symbol}`],
		types: true,
		tests: true,
	},
	{ view: "flow", symbol, side: "head", depth: 5, utilities: true, selected: symbol },
	{ view: "symbol", symbol, side: "base" },
	{ view: "file", file: "a/b.ts", side: "head", line: 12 },
	{ view: "changes", section: "groups", group: "g1", tab: "source", symbol },
	{ view: "changes", section: "contracts", tab: "calls" },
];

describe("route", () => {
	test.each(routes)("round-trips %#", (route) => {
		expect(parseHash(formatHash(route), fallback)).toEqual(route);
	});

	test("falls back on an empty or unknown hash", () => {
		expect(parseHash("", fallback)).toBe(fallback);
		expect(parseHash("#/nope", fallback)).toBe(fallback);
		expect(parseHash("#/symbol", fallback)).toBe(fallback);
	});

	test("clamps flow depth", () => {
		const route = parseHash("#/flow?d=99", fallback);
		expect(route.view === "flow" && route.depth).toBe(MAX_FLOW_DEPTH);
		const invalid = parseHash("#/flow?d=abc", fallback);
		expect(invalid.view === "flow" && invalid.depth).toBe(DEFAULT_FLOW_DEPTH);
	});
});
