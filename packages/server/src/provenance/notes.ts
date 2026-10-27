import { structuredPatch } from "diff";
import type { StaleRead, WriteEntry } from "./ledger";

const DIFF_MAX_LINES = 40;
const DIFF_LINE_MAX_CHARS = 240;
const DIFF_MAX_CHARS = 6000;
const DIFF_MAX_EDITS = 200;
const DIFF_TIMEOUT_MS = 50;
const OUTSIDE = "a terminal command or a program outside ThinkRail";
const SINCE_READ = "Changes since your last read (- what you read, + the file now)";

function formatAge(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds} s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	return `${Math.round(minutes / 60)} h ago`;
}

function authorName(entry: WriteEntry): string {
	return entry.author.kind === "user" ? "the user" : "another agent";
}

function writerPhrases(writers: readonly WriteEntry[], now: number): string[] {
	const latest = new Map<string, WriteEntry>();
	for (const entry of writers) {
		const id = entry.author.kind === "user" ? "user" : `agent:${entry.author.sessionId}`;
		latest.delete(id);
		latest.set(id, entry);
	}
	return [...latest.values()].map((entry) => `${authorName(entry)} ${formatAge(now - entry.at)}`);
}

function untrackedPhrase(stale: StaleRead): string | null {
	if (!stale.untracked) return null;
	if (!stale.script) return OUTSIDE;
	const shell = stale.script.self ? "your own shell command" : "another agent's shell command";
	return `${shell}, ${OUTSIDE}`;
}

function joinPhrases(phrases: readonly string[]): string {
	if (phrases.length <= 1) return phrases[0] ?? "";
	return `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`;
}

function who(stale: StaleRead, now: number): string {
	const untracked = untrackedPhrase(stale);
	return joinPhrases([...writerPhrases(stale.writers, now), ...(untracked ? [untracked] : [])]);
}

function clip(line: string): string {
	if (line.length <= DIFF_LINE_MAX_CHARS) return line;
	return `${line.slice(0, DIFF_LINE_MAX_CHARS)}… (${line.length - DIFF_LINE_MAX_CHARS} more chars)`;
}

function renderDiff(before: string, after: string): string[] | null {
	const patch = structuredPatch("read", "now", before, after, undefined, undefined, {
		context: 1,
		maxEditLength: DIFF_MAX_EDITS,
		timeout: DIFF_TIMEOUT_MS,
	});
	if (!patch) return null;
	const lines = patch.hunks.flatMap((hunk) => [
		`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
		...hunk.lines.map(clip),
	]);
	const shown: string[] = [];
	let chars = 0;
	for (const line of lines) {
		if (shown.length >= DIFF_MAX_LINES || chars + line.length > DIFF_MAX_CHARS) break;
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

function diffBlock(before: string | undefined, after: string | null): string {
	if (before === undefined || after === null) return "";
	const lines = renderDiff(before, after);
	if (lines === null) return "\nThe changes are too large to show as a diff.";
	if (lines.length === 0) return "";
	const marker = fence(lines);
	return `\n${SINCE_READ}:\n${marker}diff\n${lines.join("\n")}\n${marker}`;
}

interface WriteBlockInput {
	displayPath: string;
	stale: StaleRead;
	currentText: string | null;
	now: number;
	deleted: boolean;
}

export function staleWriteBlock({
	displayPath,
	stale,
	currentText,
	now,
	deleted,
}: WriteBlockInput): string {
	const by = `(by ${who(stale, now)})`;
	if (deleted) {
		return `Blocked: ${displayPath} was deleted since you read it ${by}. Read it to confirm, then write again.`;
	}
	return `Blocked: ${displayPath} changed since you read it ${by}. Re-read before writing.${diffBlock(stale.baselineText, currentText)}`;
}
