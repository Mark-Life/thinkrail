import { ChangeSet } from "@codemirror/state";
import type { EditConflict, TextChange } from "@thinkrail/resource-renderers";
import { diffArrays } from "diff";
import { refined, splitLines } from "./textChanges";

const MAX_EDIT_LENGTH = 2000;
const DIFF_TIMEOUT_MS = 50;

type Side = "mine" | "theirs";

interface Hunk {
	side: Side;
	start: number;
	end: number;
	lines: string[];
}

export type MergeConflict = Omit<EditConflict, "id">;

export type MergeRange = Pick<EditConflict, "from" | "to">;

interface PendingConflict extends MergeConflict {
	atEnd: boolean;
}

type MergeResult =
	| {
			kind: "merged";
			text: string;
			conflicts: MergeConflict[];
			changes: TextChange[];
			touched: MergeRange[];
	  }
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

function commonEdge(a: readonly string[], b: readonly string[], fromEnd: boolean, skip = 0) {
	let count = 0;
	const limit = Math.min(a.length, b.length) - skip;
	while (count < limit) {
		const index = fromEnd ? -1 - count : count;
		if (a.at(index) !== b.at(index)) break;
		count++;
	}
	return count;
}

function insertUnion(mine: readonly string[], theirs: readonly string[]): string[] | null {
	const head = commonEdge(mine, theirs, false);
	const tail = commonEdge(mine, theirs, true, head);
	const mineRest = mine.slice(head, mine.length - tail);
	const theirsRest = theirs.slice(head, theirs.length - tail);
	if (mineRest.some((line) => theirsRest.includes(line))) return null;
	return [...mine.slice(0, mine.length - tail), ...theirsRest, ...mine.slice(mine.length - tail)];
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

function exactChanges(input: {
	mine: string;
	mineText: string;
	merged: string;
	text: string;
	changes: readonly TextChange[];
}): TextChange[] {
	let set = ChangeSet.of(input.changes, input.mineText.length);
	if (input.mineText !== input.mine) {
		set = ChangeSet.of({ from: input.mine.length, insert: "\n" }, input.mine.length).compose(set);
	}
	if (input.text !== input.merged) {
		set = set.compose(
			ChangeSet.of({ from: input.text.length, to: input.merged.length }, input.merged.length),
		);
	}
	const out: TextChange[] = [];
	set.iterChanges((from, to, _fromB, _toB, inserted) => {
		out.push({ from, to, insert: inserted.toString() });
	});
	return out;
}

export function merge3(input: { base: string; mine: string; theirs: string }): MergeResult {
	const base = normalizedLines(input.base);
	const mineLines = normalizedLines(input.mine);
	const mineHunks = hunks(base, mineLines, "mine");
	const theirsHunks = hunks(base, normalizedLines(input.theirs), "theirs");
	if (!mineHunks || !theirsHunks) return { kind: "tooLarge" };
	const mineText = mineLines.join("");
	const out: string[] = [];
	const conflicts: PendingConflict[] = [];
	const changes: TextChange[] = [];
	const touched: MergeRange[] = [];
	let length = 0;
	let minePosition = 0;
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
		const gap = base.slice(position, start);
		emit(gap);
		minePosition += gap.join("").length;
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
		const from = length;
		const union = group.every(isInsert) ? insertUnion(mine, theirs) : null;
		let emitted = mine;
		if (!sides.has("theirs") || mine.join("") === theirs.join("")) {
			emit(mine);
		} else if (!sides.has("mine")) {
			emitted = theirs;
			emit(theirs);
		} else if (union) {
			emitted = union;
			emit(union);
		} else {
			emit(mine);
			conflicts.push({ from, to: length, theirs: theirs.join(""), atEnd: end === base.length });
		}
		if (sides.has("theirs")) touched.push({ from, to: length });
		const mineChunk = mine.join("");
		if (emitted.join("") !== mineChunk) {
			changes.push(
				refined(mineText, {
					from: minePosition,
					to: minePosition + mineChunk.length,
					insert: emitted.join(""),
				}),
			);
		}
		minePosition += mineChunk.length;
	}
	emit(base.slice(position));
	const merged = out.join("");
	const keepNewline = trailingNewline(input.base, input.mine, input.theirs);
	const text = keepNewline || merged === "" ? merged : merged.slice(0, -1);
	const clamp = (range: MergeRange) => ({
		from: Math.min(range.from, text.length),
		to: Math.min(range.to, text.length),
	});
	return {
		kind: "merged",
		text,
		changes: exactChanges({ mine: input.mine, mineText, merged, text, changes }),
		touched: touched.map(clamp),
		conflicts: conflicts.map(({ atEnd, ...conflict }) => {
			if (conflict.to < merged.length) return conflict;
			const dropNewline = !endsLine(input.theirs) && (atEnd || text !== merged);
			const theirs = dropNewline ? conflict.theirs.slice(0, -1) : conflict.theirs;
			if (conflict.from > text.length) {
				return { from: text.length, to: text.length, theirs: `\n${theirs}` };
			}
			return { from: conflict.from, to: Math.min(conflict.to, text.length), theirs };
		}),
	};
}
