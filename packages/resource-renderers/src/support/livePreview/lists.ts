import { syntaxTree } from "@codemirror/language";
import {
	EditorSelection,
	type EditorState,
	type Line,
	type TransactionSpec,
} from "@codemirror/state";
import type { Tree } from "@lezer/common";

const LIST_ITEM = /^((?:[ \t]*>[ \t]?)*)([ \t]*)(?:([-*+])|(\d+)([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/;
const INDENT = /^[ \t]*/;
const QUOTE_LEVEL = /[ \t]*>[ \t]?/gy;

function inCode(tree: Tree, at: number): boolean {
	for (let node = tree.resolveInner(at, -1); node.parent; node = node.parent) {
		if (node.name === "FencedCode" || node.name === "CodeBlock") return true;
	}
	return false;
}

function quoteLevels(tree: Tree, line: Line): string[] {
	const levels: string[] = [];
	let at = 0;
	for (const [level] of line.text.matchAll(QUOTE_LEVEL)) {
		if (tree.resolveInner(line.from + at + level.indexOf(">"), 1).name !== "QuoteMark") break;
		levels.push(level);
		at += level.length;
	}
	return levels;
}

export function continueList(state: EditorState): TransactionSpec | null {
	const { main } = state.selection;
	if (state.selection.ranges.length > 1) return null;
	const line = state.doc.lineAt(main.from);
	if (state.doc.lineAt(main.to).number !== line.number) return null;
	const tree = syntaxTree(state);
	if (inCode(tree, main.from)) return null;
	const match = LIST_ITEM.exec(line.text);
	if (!match) return null;
	const [prefix, quote = "", indent = "", bullet, number, delimiter = ".", space = " ", task] =
		match;
	const markAt = line.from + quote.length + indent.length;
	if (tree.resolveInner(markAt, 1).name !== "ListMark") return null;
	if (main.from - line.from < prefix.length) return null;
	if (line.text.slice(prefix.length).trim() === "") {
		const insert = `${quote.trimEnd()}\n${quote}`;
		return {
			changes: { from: line.from, to: line.to, insert },
			selection: EditorSelection.cursor(line.from + insert.length),
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
	const tree = syntaxTree(state);
	return {
		...state.changeByRange((range) => {
			const line = state.doc.lineAt(range.from);
			const levels = quoteLevels(tree, line);
			const quote = levels.join("");
			const rest = line.text.slice(quote.length);
			if (
				levels.length > 0 &&
				rest.trim() === "" &&
				range.empty &&
				range.from === line.to &&
				!inCode(tree, range.from)
			) {
				const outer = levels.slice(0, -1).join("");
				return {
					changes: { from: line.from, to: line.to, insert: outer },
					range: EditorSelection.cursor(line.from + outer.length),
				};
			}
			const head = quote + (INDENT.exec(rest)?.[0] ?? "");
			const insert = `\n${head.slice(0, range.from - line.from)}`;
			return {
				changes: { from: range.from, to: range.to, insert },
				range: EditorSelection.cursor(range.from + insert.length),
			};
		}),
		scrollIntoView: true,
		userEvent: "input",
	};
}
