import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";

const LIST_ITEM = /^((?:[ \t]*>[ \t]?)*)([ \t]*)(?:([-*+])|(\d+)([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/;
const INDENT = /^[ \t]*/;

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
	const [prefix, quote = "", indent = "", bullet, number, delimiter = ".", space = " ", task] =
		match;
	const markAt = line.from + quote.length + indent.length;
	if (tree.resolveInner(markAt, 1).name !== "ListMark") return null;
	if (main.from - line.from < prefix.length) return null;
	if (line.text.slice(prefix.length).trim() === "") {
		return {
			changes: { from: line.from, to: line.to, insert: quote },
			selection: EditorSelection.cursor(line.from + quote.length),
			userEvent: "delete",
		};
	}
	const marker = bullet ?? `${Number(number) + 1}${delimiter}`;
	const insert = `\n${quote}${indent}${marker}${space}${task ? "[ ] " : ""}`;
	return {
		changes: { from: main.from, to: main.to, insert },
		selection: EditorSelection.cursor(main.from + insert.length),
		scrollIntoView: true,
		userEvent: "input",
	};
}

export function newlineKeepingIndent(state: EditorState): TransactionSpec {
	return {
		...state.changeByRange((range) => {
			const line = state.doc.lineAt(range.from);
			const indent = (INDENT.exec(line.text)?.[0] ?? "").slice(0, range.from - line.from);
			const insert = `\n${indent}`;
			return {
				changes: { from: range.from, to: range.to, insert },
				range: EditorSelection.cursor(range.from + insert.length),
			};
		}),
		scrollIntoView: true,
		userEvent: "input",
	};
}
