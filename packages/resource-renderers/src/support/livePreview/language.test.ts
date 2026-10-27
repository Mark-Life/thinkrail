import { describe, expect, test } from "bun:test";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { markdownLanguage } from "./language";

function nodes(state: EditorState) {
	const tree = ensureSyntaxTree(state, state.doc.length, 1000);
	const names: string[] = [];
	tree?.iterate({
		enter: (ref) => {
			if (ref.name !== "Document") names.push(`${ref.name}@${ref.from}`);
			return ref.name === "Document";
		},
	});
	return names;
}

describe("markdownLanguage", () => {
	test("front matter that appears or goes away in an edit reparses the lines it covers", () => {
		const body = "note: |\n  ```\n---\n# Heading\n";
		const plain = EditorState.create({ doc: body, extensions: markdownLanguage });
		expect(nodes(plain)).toEqual(["Paragraph@0", "FencedCode@10"]);
		const fronted = plain.update({ changes: { from: 0, insert: "---\n" } }).state;
		expect(nodes(fronted)).toEqual(["ATXHeading1@22"]);
		const removed = fronted.update({ changes: { from: 0, to: 4 } }).state;
		expect(nodes(removed)).toEqual(["Paragraph@0", "FencedCode@10"]);
	});
});
