import { diffLines } from "diff";

export interface DiffCell {
	line: number;
	text: string;
}

type DiffRow =
	| { kind: "same" | "change"; left: DiffCell; right: DiffCell }
	| { kind: "remove"; left: DiffCell }
	| { kind: "add"; right: DiffCell };

export type DisplayRow = DiffRow | { kind: "fold"; hidden: number; id: number };

function splitChunk(value: string) {
	const lines = value.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

export function sideBySide(input: {
	before: string;
	after: string;
	beforeStart: number;
	afterStart: number;
}) {
	const rows: DiffRow[] = [];
	let leftLine = input.beforeStart;
	let rightLine = input.afterStart;
	let pendingRemoved: DiffCell[] = [];
	const flushRemoved = () => {
		for (const left of pendingRemoved) rows.push({ kind: "remove", left });
		pendingRemoved = [];
	};
	for (const chunk of diffLines(input.before, input.after)) {
		const lines = splitChunk(chunk.value);
		if (chunk.removed) {
			flushRemoved();
			pendingRemoved = lines.map((text) => ({ line: leftLine++, text }));
			continue;
		}
		if (chunk.added) {
			lines.forEach((text, index) => {
				const right = { line: rightLine++, text };
				const left = pendingRemoved[index];
				rows.push(left ? { kind: "change", left, right } : { kind: "add", right });
			});
			pendingRemoved = pendingRemoved.slice(lines.length);
			flushRemoved();
			continue;
		}
		flushRemoved();
		for (const text of lines) {
			rows.push({
				kind: "same",
				left: { line: leftLine++, text },
				right: { line: rightLine++, text },
			});
		}
	}
	flushRemoved();
	return rows;
}

export function foldUnchanged(input: { rows: readonly DiffRow[]; context: number }) {
	const { rows, context } = input;
	const keep = new Set<number>();
	rows.forEach((row, index) => {
		if (row.kind === "same") return;
		for (let near = index - context; near <= index + context; near++) keep.add(near);
	});
	const display: DisplayRow[] = [];
	let hidden = 0;
	rows.forEach((row, index) => {
		if (row.kind !== "same" || keep.has(index)) {
			if (hidden > 0) display.push({ kind: "fold", hidden, id: index });
			hidden = 0;
			display.push(row);
			return;
		}
		hidden += 1;
	});
	if (hidden > 0) display.push({ kind: "fold", hidden, id: rows.length });
	return display;
}
