import type { TextChange } from "@thinkrail/resource-renderers";
import { diffArrays } from "diff";

const MAX_EDIT_LENGTH = 2000;
const DIFF_TIMEOUT_MS = 50;

interface LinePart {
	value: string[];
	added: boolean;
	removed: boolean;
}

export function applyChanges(text: string, changes: readonly TextChange[]): string {
	let next = text;
	for (const change of [...changes].sort((left, right) => right.from - left.from)) {
		next = next.slice(0, change.from) + change.insert + next.slice(change.to);
	}
	return next;
}

function lines(text: string): string[] {
	return text === "" ? [] : text.split(/(?<=\n)/);
}

function trimmedChange(previous: string, next: string): TextChange {
	const limit = Math.min(previous.length, next.length);
	let start = 0;
	while (start < limit && previous[start] === next[start]) start += 1;
	let end = 0;
	while (
		end < limit - start &&
		previous[previous.length - 1 - end] === next[next.length - 1 - end]
	) {
		end += 1;
	}
	return {
		from: start,
		to: previous.length - end,
		insert: next.slice(start, next.length - end),
	};
}

function refined(previous: string, change: TextChange): TextChange {
	const inner = trimmedChange(previous.slice(change.from, change.to), change.insert);
	return { from: change.from + inner.from, to: change.from + inner.to, insert: inner.insert };
}

function alignedParts(before: string[], after: string[]): LinePart[] | null {
	if (before.length !== after.length) return null;
	return before.flatMap<LinePart>((line, index) => {
		const other = after[index] ?? "";
		return line === other
			? [{ value: [line], added: false, removed: false }]
			: [
					{ value: [line], added: false, removed: true },
					{ value: [other], added: true, removed: false },
				];
	});
}

export function textChanges(previous: string, next: string): TextChange[] {
	if (previous === next) return [];
	const before = lines(previous);
	const after = lines(next);
	const parts =
		diffArrays(before, after, { maxEditLength: MAX_EDIT_LENGTH, timeout: DIFF_TIMEOUT_MS }) ??
		alignedParts(before, after);
	if (!parts) return [trimmedChange(previous, next)];
	const changes: TextChange[] = [];
	let offset = 0;
	let pending: TextChange | null = null;
	for (const part of parts) {
		const value = part.value.join("");
		if (!part.added && !part.removed) {
			if (pending) changes.push(refined(previous, pending));
			pending = null;
			offset += value.length;
			continue;
		}
		pending ??= { from: offset, to: offset, insert: "" };
		if (part.removed) {
			offset += value.length;
			pending.to = offset;
		} else {
			pending.insert += value;
		}
	}
	if (pending) changes.push(refined(previous, pending));
	return changes;
}
