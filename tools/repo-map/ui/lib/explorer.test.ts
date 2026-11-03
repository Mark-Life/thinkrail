import { describe, expect, test } from "bun:test";
import type { CodeSymbol, FileInfo, SymbolId } from "../../core/types";
import { buildFileTree, flattenExplorer, pushRecent, revealKeys } from "./explorer";
import { makeSymbol, sid } from "./fixture";

function file(path: string): FileInfo {
	return {
		path,
		module: path.slice(0, path.lastIndexOf("/")),
		lines: 10,
		isTest: false,
		commits90d: 0,
		imports: [],
		contentHash: "",
		tokenHash: "",
	};
}

const handlers = "packages/server/src/host/handlers.ts";
const transport = "apps/web/src/transport/transport.ts";
const tree = buildFileTree([file(handlers), file(transport), file("README.ts")]);
const prompt = makeSymbol({ file: handlers, name: "promptSession", startLine: 8 });
const start = makeSymbol({ file: handlers, name: "start", startLine: 2 });
const request = makeSymbol({ file: transport, name: "request" });
const moduleSymbol = makeSymbol({ file: handlers, name: "(module)", kind: "module" });
const fileSymbols = new Map<string, CodeSymbol[]>([
	[handlers, [prompt, moduleSymbol, start]],
	[transport, [request]],
]);

function labels(expanded: string[], filter = "") {
	return flattenExplorer({ tree, expanded: new Set(expanded), fileSymbols, filter }).map((row) =>
		row.kind === "symbol" ? `#${row.symbol.name}` : row.name,
	);
}

describe("buildFileTree", () => {
	test("joins folders that hold a single folder", () => {
		expect(tree.dirs.map((dir) => dir.name)).toEqual([
			"apps/web/src/transport",
			"packages/server/src/host",
		]);
		expect(tree.files.map((entry) => entry.path)).toEqual(["README.ts"]);
	});
});

describe("flattenExplorer", () => {
	test("starts with only the top level", () => {
		expect(labels([])).toEqual(["apps/web/src/transport", "packages/server/src/host", "README.ts"]);
	});

	test("lists symbols of an open file by line, without the module symbol", () => {
		expect(labels(["packages/server/src/host", handlers])).toEqual([
			"apps/web/src/transport",
			"packages/server/src/host",
			"handlers.ts",
			"#start",
			"#promptSession",
			"README.ts",
		]);
	});

	test("nests a symbol under its parent", () => {
		const method = makeSymbol({
			file: transport,
			name: "request.send",
			startLine: 3,
			parent: request.id,
		});
		const rows = flattenExplorer({
			tree,
			expanded: new Set(["apps/web/src/transport", transport]),
			fileSymbols: new Map([[transport, [request, method]]]),
			filter: "",
		});
		expect(rows.filter((row) => row.kind === "symbol").map((row) => row.depth)).toEqual([2, 3]);
	});

	test("a filter opens matches and hides the rest", () => {
		expect(labels([], "PROMPT")).toEqual([
			"packages/server/src/host",
			"handlers.ts",
			"#promptSession",
		]);
	});

	test("a filter that matches a path keeps the file closed", () => {
		expect(labels([], "transport.ts")).toEqual(["apps/web/src/transport", "transport.ts"]);
	});

	test("a filter with no match gives no rows", () => {
		expect(labels([], "zzz")).toEqual([]);
	});
});

describe("revealKeys", () => {
	test("returns the file and its joined folder", () => {
		expect(revealKeys(tree, handlers)).toEqual([handlers, "packages/server/src/host"]);
	});
});

describe("pushRecent", () => {
	const id = (name: string): SymbolId => sid("a.ts", name);

	test("moves a repeat to the front", () => {
		expect(pushRecent([id("a"), id("b")], id("b"))).toEqual([id("b"), id("a")]);
	});

	test("keeps the list bounded", () => {
		const full = Array.from({ length: 30 }, (_, index) => id(`s${index}`));
		const next = pushRecent(full, id("new"));
		expect(next).toHaveLength(30);
		expect(next[0]).toBe(id("new"));
	});
});
