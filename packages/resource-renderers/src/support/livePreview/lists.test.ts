import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { markdownLanguage } from "./language";
import { continueList } from "./lists";

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
