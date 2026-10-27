import type { TextChange } from "@thinkrail/resource-renderers";
import { diffArrays } from "diff";

export const MAX_EDIT_LENGTH = 2000;
export const DIFF_TIMEOUT_MS = 50;

interface LinePart {
	value: string[];
	added: boolean;
	removed: boolean;
}

export function splitLines(text: string): string[] {
	return text === "" ? [] : text.split(/(?<=\n)/);
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

function trimmedChange(previous: string, next: string): TextChange {
	const limit = Math.min(previous.length, next.length);
	let start = 0;
	while (start < limit && previous[start] === next[start]) start += 1;
	if (start > 0 && isHighSurrogate(previous.charCodeAt(start - 1))) start -= 1;
	let end = 0;
	while (
		end < limit - start &&
		previous[previous.length - 1 - end] === next[next.length - 1 - end]
	) {
		end += 1;
	}
	if (end > 0 && isLowSurrogate(previous.charCodeAt(previous.length - end))) end -= 1;
	return {
		from: start,
		to: previous.length - end,
		insert: next.slice(start, next.length - end),
	};
}

export function refined(previous: string, change: TextChange): TextChange {
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
	const before = splitLines(previous);
	const after = splitLines(next);
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
