import { describe, expect, test } from "bun:test";
import { makeEdge, makeSymbol, sid } from "./fixture";
import { edgesByLine, innermostSymbol, linksForLine, splitTokens } from "./sourceLinks";

const load = makeSymbol({ file: "a/b.ts", name: "load", startLine: 9 });
const prompt = makeSymbol({ file: "s/h.ts", name: "session.prompt", kind: "wire-handler" });
const method = makeSymbol({ file: "a/s.ts", name: "store.save", kind: "method" });
const symbols = new Map([load, prompt, method].map((symbol) => [symbol.id, symbol]));
const from = sid("a/x.ts", "caller");

describe("linksForLine", () => {
	test("links a call name as a whole word", () => {
		const links = linksForLine({
			text: "const unload = load(value);",
			edges: [makeEdge({ from, to: load.id })],
			symbols,
		});
		expect(links).toHaveLength(1);
		expect(links[0]?.start).toBe(15);
		expect(links[0]?.title).toBe("a/b.ts:9");
	});

	test("links the last segment of a member name", () => {
		const links = linksForLine({
			text: "store.save(x)",
			edges: [makeEdge({ from, to: method.id })],
			symbols,
		});
		expect(links[0]?.start).toBe(6);
	});

	test("links the wire method literal", () => {
		const text = 'await request("session.prompt", {});';
		const links = linksForLine({
			text,
			edges: [makeEdge({ from, to: prompt.id, kind: "wire-request", label: "session.prompt" })],
			symbols,
		});
		expect(text.slice(links[0]?.start, links[0]?.end)).toBe("session.prompt");
		expect(links[0]?.kind).toBe("wire-request");
	});

	test("gives no link when the name is not on the line", () => {
		expect(
			linksForLine({ text: "foo()", edges: [makeEdge({ from, to: load.id })], symbols }),
		).toEqual([]);
	});

	test("does not link twice over one range", () => {
		const twin = makeSymbol({ file: "z/b.ts", name: "load" });
		const links = linksForLine({
			text: "load()",
			edges: [makeEdge({ from, to: load.id }), makeEdge({ from, to: twin.id })],
			symbols: new Map([...symbols, [twin.id, twin]]),
		});
		expect(links).toHaveLength(1);
	});
});

describe("repeat calls in the enclosing symbol", () => {
	const enclosing = [makeEdge({ from, to: load.id, line: 2 })];

	test("links a later call of a known target", () => {
		const links = linksForLine({ text: "a = load(x)", edges: [], enclosing, symbols });
		expect(links.map((link) => link.start)).toEqual([4]);
	});

	test("links JSX of a known component", () => {
		const links = linksForLine({ text: "return <load x={1} />", edges: [], enclosing, symbols });
		expect(links.map((link) => link.start)).toEqual([8]);
	});

	test("links a wire method literal on a line after the call starts", () => {
		const wire = [makeEdge({ from, to: prompt.id, kind: "wire-request", label: "session.prompt" })];
		const text = '.request("session.prompt", {})';
		const links = linksForLine({ text, edges: [], enclosing: wire, symbols });
		expect(text.slice(links[0]?.start, links[0]?.end)).toBe("session.prompt");
	});

	test("ignores a plain mention that is not a call", () => {
		expect(linksForLine({ text: "const load = 1;", edges: [], enclosing, symbols })).toEqual([]);
		expect(linksForLine({ text: "x.reload(y)", edges: [], enclosing, symbols })).toEqual([]);
	});

	test("does not add type references", () => {
		const types = [makeEdge({ from, to: load.id, kind: "type-ref" })];
		expect(linksForLine({ text: "load()", edges: [], enclosing: types, symbols })).toEqual([]);
	});

	test("picks the innermost enclosing symbol", () => {
		const outer = { id: "outer", startLine: 1, endLine: 100 };
		const inner = { id: "inner", startLine: 10, endLine: 20 };
		expect(innermostSymbol([outer, inner], 15)?.id).toBe("inner");
		expect(innermostSymbol([outer, inner], 50)?.id).toBe("outer");
		expect(innermostSymbol([inner], 50)).toBeUndefined();
	});
});

describe("edgesByLine", () => {
	test("groups by line", () => {
		const lines = edgesByLine([
			makeEdge({ from, to: load.id, line: 3 }),
			makeEdge({ from, to: prompt.id, line: 3 }),
			makeEdge({ from, to: method.id, line: 4 }),
		]);
		expect(lines.get(3)).toHaveLength(2);
	});
});

describe("splitTokens", () => {
	const link = { start: 2, end: 6, target: load.id, kind: "call" as const, title: "" };

	test("keeps all text and colors when a link spans tokens", () => {
		const segments = splitTokens({
			tokens: [
				{ content: "abcd", color: "red" },
				{ content: "efgh", color: "blue" },
			],
			links: [link],
		});
		expect(segments.map((segment) => segment.content).join("")).toBe("abcdefgh");
		expect(
			segments.map((segment) => [segment.content, segment.color, Boolean(segment.link)]),
		).toEqual([
			["ab", "red", false],
			["cd", "red", true],
			["ef", "blue", true],
			["gh", "blue", false],
		]);
	});

	test("passes tokens through when no link is present", () => {
		expect(splitTokens({ tokens: [{ content: "x" }], links: [] })).toEqual([{ content: "x" }]);
	});
});
