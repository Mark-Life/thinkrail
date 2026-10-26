import type { TextChange } from "../registry";

export const PRESENCE_TIMING = {
	washMs: 2400,
	flagMs: 5000,
	chipMs: 10_000,
	holdMs: 60_000,
	pendingMs: 3000,
} as const;

const WHOLE_FILE_SHARE = 0.5;
const WHOLE_FILE_MIN_LINES = 10;
const DIFF_MAX_LINES = 12;
const DIFF_MAX_CHARS = 160;

export interface PresenceSpan {
	startLine: number;
	endLine: number;
}

export type PresencePaint =
	| { kind: "lines"; spans: PresenceSpan[]; diff: string[] }
	| { kind: "file" };

function applyChanges(before: string, changes: readonly TextChange[]): string {
	let out = "";
	let cursor = 0;
	for (const change of changes) {
		out += before.slice(cursor, change.from) + change.insert;
		cursor = change.to;
	}
	return out + before.slice(cursor);
}

function lineStarts(text: string): number[] {
	const starts = [0];
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
		starts.push(index + 1);
	}
	return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if ((starts[mid] ?? 0) <= offset) low = mid;
		else high = mid - 1;
	}
	return low + 1;
}

function lineCount(text: string): number {
	const lines = text.split("\n").length;
	return text.endsWith("\n") ? lines - 1 : lines;
}

function joinSpans(spans: PresenceSpan[]): PresenceSpan[] {
	const joined: PresenceSpan[] = [];
	for (const span of [...spans].sort((a, b) => a.startLine - b.startLine)) {
		const last = joined.at(-1);
		if (last && span.startLine <= last.endLine + 1)
			last.endLine = Math.max(last.endLine, span.endLine);
		else joined.push({ ...span });
	}
	return joined;
}

function spanLines(spans: readonly PresenceSpan[]): number {
	return spans.reduce((sum, span) => sum + span.endLine - span.startLine + 1, 0);
}

function clip(line: string): string {
	return line.length > DIFF_MAX_CHARS ? `${line.slice(0, DIFF_MAX_CHARS)}…` : line;
}

function spanOf(starts: readonly number[], start: number, text: string): PresenceSpan {
	const leadingBreak = text.length > 1 && text.startsWith("\n") ? 1 : 0;
	const end = start + text.length;
	const last = text.endsWith("\n") && text.length > leadingBreak ? end - 1 : end;
	const startLine = lineAt(starts, start + leadingBreak);
	return { startLine, endLine: Math.max(startLine, lineAt(starts, last)) };
}

function spanText(text: string, starts: readonly number[], span: PresenceSpan): string[] {
	const start = starts[span.startLine - 1] ?? 0;
	const endIndex = text.indexOf("\n", starts[span.endLine - 1] ?? 0);
	return text.slice(start, endIndex === -1 ? text.length : endIndex).split("\n");
}

export function presencePaint(input: {
	before: string;
	changes: readonly TextChange[];
}): PresencePaint | null {
	const changes = [...input.changes].sort((a, b) => a.from - b.from);
	if (changes.length === 0) return null;
	const after = applyChanges(input.before, changes);
	const afterStarts = lineStarts(after);
	const beforeStarts = lineStarts(input.before);
	const spans: PresenceSpan[] = [];
	const removedSpans: PresenceSpan[] = [];
	const diff: string[] = [];
	let shift = 0;
	for (const change of changes) {
		const start = change.from + shift;
		shift += change.insert.length - (change.to - change.from);
		const span = spanOf(afterStarts, start, change.insert);
		spans.push(span);
		const removedText = input.before.slice(change.from, change.to);
		const removedSpan = removedText === "" ? null : spanOf(beforeStarts, change.from, removedText);
		if (removedSpan) removedSpans.push(removedSpan);
		if (diff.length >= DIFF_MAX_LINES) continue;
		const removed = removedSpan ? spanText(input.before, beforeStarts, removedSpan) : [];
		const added = change.insert === "" ? [] : spanText(after, afterStarts, span);
		for (const line of removed) diff.push(`- ${clip(line)}`);
		for (const line of added) diff.push(`+ ${clip(line)}`);
	}
	const joined = joinSpans(spans);
	const changedLines = Math.max(spanLines(joined), spanLines(joinSpans(removedSpans)));
	const totalLines = Math.max(lineCount(input.before), lineCount(after));
	if (totalLines >= WHOLE_FILE_MIN_LINES && changedLines > totalLines * WHOLE_FILE_SHARE) {
		return { kind: "file" };
	}
	return { kind: "lines", spans: joined, diff: diff.slice(0, DIFF_MAX_LINES) };
}

export function joinDiffs(newer: readonly string[], older: readonly string[]): string[] {
	return [...newer, ...older].slice(0, DIFF_MAX_LINES);
}

export function markdownText(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, "\\$&");
}

function longestBacktickRun(line: string): number {
	return Math.max(0, ...(line.match(/`+/g) ?? []).map((run) => run.length));
}

export function htmlAttribute(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export function diffFence(lines: readonly string[]): string {
	const fence = "`".repeat(Math.max(2, ...lines.map(longestBacktickRun)) + 1);
	return `${fence}diff\n${lines.join("\n")}\n${fence}`;
}
