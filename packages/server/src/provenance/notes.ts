import { structuredPatch } from "diff";
import type { StaleRead, WriteEntry } from "./ledger";

export const DIFF_MAX_LINES = 40;
export const DIFF_LINE_MAX_CHARS = 240;
const DIFF_MAX_CHARS = 6000;
const DIFF_MAX_EDITS = 4000;
const NOTE_MAX_FILES = 10;

export function formatAge(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds} s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	return `${Math.round(minutes / 60)} h ago`;
}

function authorName(entry: WriteEntry): string {
	return entry.author.kind === "user" ? "the user" : "another agent";
}

function writerPhrases(writers: readonly WriteEntry[], now: number, withLine: boolean): string[] {
	const latest = new Map<string, WriteEntry>();
	for (const entry of writers) {
		const id = entry.author.kind === "user" ? "user" : `agent:${entry.author.sessionId}`;
		latest.delete(id);
		latest.set(id, entry);
	}
	return [...latest.values()].map((entry) => {
		const line = withLine && entry.line !== undefined ? ` (line ${entry.line})` : "";
		return `${authorName(entry)} ${formatAge(now - entry.at)}${line}`;
	});
}

function untrackedPhrase(stale: StaleRead): string | null {
	if (!stale.untracked) return null;
	if (!stale.script) return "a program outside ThinkRail";
	return stale.script.self ? "your own shell command" : "another agent's shell command";
}

function joinPhrases(phrases: readonly string[]): string {
	if (phrases.length <= 1) return phrases[0] ?? "";
	return `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`;
}

function who(stale: StaleRead, now: number, withLine: boolean): string {
	const untracked = untrackedPhrase(stale);
	return joinPhrases([
		...writerPhrases(stale.writers, now, withLine),
		...(untracked ? [untracked] : []),
	]);
}

function clip(line: string): string {
	if (line.length <= DIFF_LINE_MAX_CHARS) return line;
	return `${line.slice(0, DIFF_LINE_MAX_CHARS)}… (${line.length - DIFF_LINE_MAX_CHARS} more chars)`;
}

export function renderDiff(before: string, after: string, maxLines = DIFF_MAX_LINES): string[] {
	const patch = structuredPatch("read", "now", before, after, undefined, undefined, {
		context: 1,
		maxEditLength: DIFF_MAX_EDITS,
	});
	if (!patch) return [];
	const lines = patch.hunks.flatMap((hunk) => [
		`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
		...hunk.lines.map(clip),
	]);
	const shown: string[] = [];
	let chars = 0;
	for (const line of lines) {
		if (shown.length >= maxLines || chars + line.length > DIFF_MAX_CHARS) break;
		shown.push(line);
		chars += line.length + 1;
	}
	if (shown.length === lines.length) return shown;
	return [...shown, `… ${lines.length - shown.length} more diff lines not shown.`];
}

function fence(lines: readonly string[]): string {
	let longest = 0;
	for (const run of lines.join("\n").match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	return "`".repeat(Math.max(3, longest + 1));
}

function diffBlock(stale: StaleRead, currentText: string | null): string {
	if (stale.baselineText === undefined || currentText === null) return "";
	const lines = renderDiff(stale.baselineText, currentText);
	if (lines.length === 0) return "";
	const marker = fence(lines);
	return `\nChanges since your last read (- what you read, + the file now):\n${marker}diff\n${lines.join("\n")}\n${marker}`;
}

interface NoteInput {
	displayPath: string;
	stale: StaleRead;
	currentText: string | null;
	now: number;
}

export function staleEditHint({ displayPath, stale, currentText, now }: NoteInput): string {
	const since = stale.read ? " since you last read it" : "";
	return `ThinkRail: ${displayPath} was changed by ${who(stale, now, true)}${since}. Re-read the file before editing.${diffBlock(stale, currentText)}`;
}

export function staleWriteBlock({ displayPath, stale, currentText, now }: NoteInput): string {
	return `Blocked: ${displayPath} changed since this agent read it (by ${who(stale, now, false)}). Re-read before writing.${diffBlock(stale, currentText)}`;
}

export function bashNote({
	userWrites,
	displayPath,
	now,
}: {
	userWrites: readonly WriteEntry[];
	displayPath: (path: string) => string;
	now: number;
}): string | null {
	const latest = new Map<string, WriteEntry>();
	for (const entry of userWrites) latest.set(entry.path, entry);
	if (latest.size === 0) return null;
	const entries = [...latest.values()];
	const lines = entries.slice(0, NOTE_MAX_FILES).map((entry) => {
		const line = entry.line === undefined ? "" : ` (line ${entry.line})`;
		const verb = entry.hash === null ? "deleted" : "edited";
		return `Note: the user ${verb} ${displayPath(entry.path)} ${formatAge(now - entry.at)} during this call${line}.`;
	});
	if (entries.length > NOTE_MAX_FILES) {
		lines.push(
			`Note: the user changed ${entries.length - NOTE_MAX_FILES} more files during this call.`,
		);
	}
	return lines.join("\n");
}
