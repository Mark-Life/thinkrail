import { diffArrays } from "diff";
import { splitLines } from "./textChanges";

const MAX_EDIT_LENGTH = 2000;
const DIFF_TIMEOUT_MS = 50;

type Side = "mine" | "theirs";

interface Hunk {
	side: Side;
	start: number;
	end: number;
	lines: string[];
}

export interface MergeConflict {
	from: number;
	to: number;
	theirs: string;
}

export type MergeResult =
	| { kind: "merged"; text: string; conflicts: MergeConflict[] }
	| { kind: "tooLarge" };

function endsLine(text: string): boolean {
	return text === "" || text.endsWith("\n");
}

function normalizedLines(text: string): string[] {
	return splitLines(endsLine(text) ? text : `${text}\n`);
}

function hunks(base: string[], other: string[], side: Side): Hunk[] | null {
	const parts = diffArrays(base, other, {
		maxEditLength: MAX_EDIT_LENGTH,
		timeout: DIFF_TIMEOUT_MS,
	});
	if (!parts) return null;
	const found: Hunk[] = [];
	let index = 0;
	let pending: Hunk | null = null;
	for (const part of parts) {
		if (!part.added && !part.removed) {
			if (pending) found.push(pending);
			pending = null;
			index += part.value.length;
			continue;
		}
		pending ??= { side, start: index, end: index, lines: [] };
		if (part.removed) {
			index += part.value.length;
			pending.end = index;
		} else {
			pending.lines.push(...part.value);
		}
	}
	if (pending) found.push(pending);
	return found;
}

const isInsert = (hunk: Hunk) => hunk.start === hunk.end;

function sharesLine(a: Hunk, b: Hunk): boolean {
	if (isInsert(a) && isInsert(b)) return a.start === b.start;
	if (isInsert(a)) return b.start < a.start && a.start < b.end;
	if (isInsert(b)) return a.start < b.start && b.start < a.end;
	return a.start < b.end && b.start < a.end;
}

function clusters(all: Hunk[]): Hunk[][] {
	const sorted = [...all].sort((a, b) => a.start - b.start || a.end - b.end);
	const groups: Hunk[][] = [];
	for (const hunk of sorted) {
		const current = groups.at(-1);
		if (current?.some((member) => member.side !== hunk.side && sharesLine(member, hunk))) {
			current.push(hunk);
		} else {
			groups.push([hunk]);
		}
	}
	return groups;
}

function version(base: string[], start: number, end: number, members: Hunk[]): string[] {
	const out: string[] = [];
	let position = start;
	for (const hunk of members) {
		out.push(...base.slice(position, hunk.start), ...hunk.lines);
		position = hunk.end;
	}
	out.push(...base.slice(position, end));
	return out;
}

function trailingNewline(base: string, mine: string, theirs: string): boolean {
	return endsLine(mine) === endsLine(base) ? endsLine(theirs) : endsLine(mine);
}

export function merge3(input: { base: string; mine: string; theirs: string }): MergeResult {
	const base = normalizedLines(input.base);
	const mineHunks = hunks(base, normalizedLines(input.mine), "mine");
	const theirsHunks = hunks(base, normalizedLines(input.theirs), "theirs");
	if (!mineHunks || !theirsHunks) return { kind: "tooLarge" };
	const out: string[] = [];
	const conflicts: MergeConflict[] = [];
	let length = 0;
	let position = 0;
	const emit = (lines: readonly string[]) => {
		for (const line of lines) {
			out.push(line);
			length += line.length;
		}
	};
	for (const group of clusters([...mineHunks, ...theirsHunks])) {
		const start = Math.min(...group.map((hunk) => hunk.start));
		const end = Math.max(...group.map((hunk) => hunk.end));
		emit(base.slice(position, start));
		position = end;
		const mine = version(
			base,
			start,
			end,
			group.filter((hunk) => hunk.side === "mine"),
		);
		const theirs = version(
			base,
			start,
			end,
			group.filter((hunk) => hunk.side === "theirs"),
		);
		const sides = new Set(group.map((hunk) => hunk.side));
		if (!sides.has("theirs") || mine.join("") === theirs.join("")) {
			emit(mine);
		} else if (!sides.has("mine")) {
			emit(theirs);
		} else if (group.every(isInsert)) {
			emit([...mine, ...theirs]);
		} else {
			const from = length;
			emit(mine);
			conflicts.push({ from, to: length, theirs: theirs.join("") });
		}
	}
	emit(base.slice(position));
	const merged = out.join("");
	const keepNewline = trailingNewline(input.base, input.mine, input.theirs);
	const text = keepNewline || merged === "" ? merged : merged.slice(0, -1);
	return {
		kind: "merged",
		text,
		conflicts: conflicts.map((conflict) =>
			conflict.to > text.length
				? {
						from: Math.min(conflict.from, text.length),
						to: text.length,
						theirs: endsLine(input.theirs) ? conflict.theirs : conflict.theirs.slice(0, -1),
					}
				: conflict,
		),
	};
}
