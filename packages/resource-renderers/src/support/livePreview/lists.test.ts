import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { markdownLanguage, markdownParser } from "./language";
import { continueList, newlineKeepingIndent } from "./lists";

function enter(doc: string, at = doc.length) {
	const state = EditorState.create({
		doc,
		selection: { anchor: at },
		extensions: markdownLanguage,
	});
	const spec = continueList(state);
	if (!spec) return null;
	const next = state.update(spec).state;
	return { text: next.doc.toString(), caret: next.selection.main.head };
}

describe("continueList", () => {
	test("Enter at the end of an item starts the next one with the same marker", () => {
		expect(enter("- one")).toEqual({ text: "- one\n- ", caret: 8 });
		expect(enter("  * one")).toEqual({ text: "  * one\n  * ", caret: 12 });
	});
	test("an ordered item counts on and keeps its delimiter", () => {
		expect(enter("9) nine")).toEqual({ text: "9) nine\n10) ", caret: 12 });
	});
	test("a task item continues as an open task", () => {
		expect(enter("- [x] done")).toEqual({ text: "- [x] done\n- [ ] ", caret: 17 });
	});
	test("Enter on an empty item ends the list", () => {
		expect(enter("- one\n- ")).toEqual({ text: "- one\n", caret: 6 });
	});
	test("Enter inside the marker, outside a list, or in code falls through", () => {
		expect(enter("- one", 1)).toBeNull();
		expect(enter("plain")).toBeNull();
		expect(enter("```\n- not a list")).toBeNull();
	});
	test("Enter after a thematic break written with spaced markers starts no list", () => {
		expect(enter("* * *")).toBeNull();
		expect(enter("- - -")).toBeNull();
		expect(enter("text\n\n- - -")).toBeNull();
	});
});

function enterKey(doc: string, at = doc.length) {
	const state = EditorState.create({
		doc,
		selection: { anchor: at },
		extensions: markdownLanguage,
	});
	const next = state.update(continueList(state) ?? newlineKeepingIndent(state)).state;
	return { text: next.doc.toString(), caret: next.selection.main.head };
}

describe("Enter outside a list item", () => {
	test("a line in a fence inside a list item keeps its indent, so the item goes on", () => {
		const doc = "- item\n\n  ```js\n  const a = 1;\n  ```\n";
		const at = doc.indexOf("1;") + 2;
		const { text, caret } = enterKey(doc, at);
		expect(text).toBe("- item\n\n  ```js\n  const a = 1;\n  \n  ```\n");
		const typed = `${text.slice(0, caret)}b${text.slice(caret)}`;
		const tree = markdownParser.parse(typed);
		const list = tree.topNode.getChild("BulletList");
		expect(list?.to).toBeGreaterThanOrEqual(typed.indexOf("  ```\n", at) + 5);
	});
	test("a continuation paragraph and a tab-indented code line keep their indent", () => {
		expect(enterKey("- item\n\n  more text").text).toBe("- item\n\n  more text\n  ");
		expect(enterKey("```\n\tfoo\n```", 8).text).toBe("```\n\tfoo\n\t\n```");
	});
	test("a caret inside the indent keeps only the indent before it", () => {
		expect(enterKey("    deep", 2).text).toBe("  \n    deep");
	});
	test("a top-level line starts the next line at column 0", () => {
		expect(enterKey("plain").text).toBe("plain\n");
	});
});

describe("continueList inside a quote", () => {
	test("Enter on a quoted item starts the next quoted item", () => {
		expect(enter("> - item")).toEqual({ text: "> - item\n> - ", caret: 13 });
		expect(enter("> 1. one")).toEqual({ text: "> 1. one\n> 2. ", caret: 14 });
	});
	test("Enter on an empty quoted item ends the list and keeps the quote", () => {
		expect(enter("> - one\n> - ")).toEqual({ text: "> - one\n> ", caret: 10 });
	});
});
