import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";

const LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;

export function continueList(state: EditorState): TransactionSpec | null {
	const { main } = state.selection;
	if (state.selection.ranges.length > 1) return null;
	const line = state.doc.lineAt(main.from);
	if (state.doc.lineAt(main.to).number !== line.number) return null;
	const tree = syntaxTree(state);
	for (let node = tree.resolveInner(main.from, -1); node.parent; node = node.parent) {
		if (node.name === "FencedCode" || node.name === "CodeBlock") return null;
	}
	const match = LIST_ITEM.exec(line.text);
	if (!match) return null;
	const markAt = line.from + (match[1]?.length ?? 0);
	if (tree.resolveInner(markAt, 1).name !== "ListMark") return null;
	const prefix = match[0];
	if (main.from - line.from < prefix.length) return null;
	if (line.text.slice(prefix.length).trim() === "") {
		return {
			changes: { from: line.from, to: line.to, insert: "" },
			selection: EditorSelection.cursor(line.from),
			userEvent: "delete",
		};
	}
	const [, indent = "", bullet, number, delimiter = ".", space = " ", task] = match;
	const marker = bullet ?? `${Number(number) + 1}${delimiter}`;
	const insert = `\n${indent}${marker}${space}${task ? "[ ] " : ""}`;
	return {
		changes: { from: main.from, to: main.to, insert },
		selection: EditorSelection.cursor(main.from + insert.length),
		scrollIntoView: true,
		userEvent: "input",
	};
}
