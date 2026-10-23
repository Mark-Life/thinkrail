import { expect, test } from "bun:test";
import type { StaleRead, WriteEntry } from "./ledger";
import {
	bashNote,
	DIFF_MAX_LINES,
	formatAge,
	renderDiff,
	staleEditHint,
	staleWriteBlock,
} from "./notes";
import { firstChangedLine } from "./snapshot";

const NOW = 100_000;

function entry(overrides: Partial<WriteEntry>): WriteEntry {
	return {
		seq: 1,
		at: NOW - 4000,
		path: "/w/src/auth.ts",
		hash: "h",
		author: { kind: "user", clientKey: "c" },
		...overrides,
	};
}

function stale(overrides: Partial<StaleRead>): StaleRead {
	return {
		path: "/w/src/auth.ts",
		baseline: { hash: "b", at: NOW - 10_000 },
		writers: [],
		untracked: false,
		...overrides,
	};
}

test("formatAge rounds to seconds, minutes and hours", () => {
	expect(formatAge(4200)).toBe("4 s ago");
	expect(formatAge(-50)).toBe("0 s ago");
	expect(formatAge(3 * 60_000)).toBe("3 min ago");
	expect(formatAge(2 * 3_600_000)).toBe("2 h ago");
});

test("firstChangedLine is 1-based and points at the first differing line", () => {
	expect(firstChangedLine("a\nb\nc\n", "a\nB\nc\n")).toBe(2);
	expect(firstChangedLine("a\n", "a\nb\n")).toBe(2);
	expect(firstChangedLine("a\nb\n", "a\n")).toBe(2);
	expect(firstChangedLine("same", "same")).toBeUndefined();
});

test("the edit hint is the pointer, then the diff from what the agent read", () => {
	const text = staleEditHint({
		displayPath: "src/auth.ts",
		stale: stale({
			writers: [entry({ line: 10 })],
			baselineText: "a\nttl = 60\nb\n",
		}),
		currentText: "a\nttl = 3600\nb\n",
		now: NOW,
	});
	expect(text).toBe(
		[
			"ThinkRail: src/auth.ts was changed by You 4 s ago (line 10) since you last read it. Re-read the file before editing.",
			"Changes since your last read (- what you read, + the file now):",
			"```diff",
			"@@ -1,3 +1,3 @@",
			" a",
			"-ttl = 60",
			"+ttl = 3600",
			" b",
			"```",
		].join("\n"),
	);
});

test("repeated saves by one author collapse into its latest, and untracked writers are named", () => {
	const text = staleEditHint({
		displayPath: "a.ts",
		stale: stale({
			writers: [
				entry({ at: NOW - 9000, line: 1 }),
				entry({ at: NOW - 2000, line: 3 }),
				entry({ author: { kind: "agent", sessionId: "s2", via: "tool", toolName: "edit" } }),
			],
			untracked: true,
		}),
		currentText: null,
		now: NOW,
	});
	expect(text).toBe(
		"ThinkRail: a.ts was changed by You 2 s ago (line 3), another agent 4 s ago and a program outside ThinkRail since you last read it. Re-read the file before editing.",
	);
});

test("a hint without a baseline has no since clause and no diff", () => {
	const text = staleEditHint({
		displayPath: "a.ts",
		stale: stale({ baseline: null, writers: [entry({ line: 2 })] }),
		currentText: "x\n",
		now: NOW,
	});
	expect(text).toBe(
		"ThinkRail: a.ts was changed by You 4 s ago (line 2). Re-read the file before editing.",
	);
});

test("the write block names the writers and the agent's own shell", () => {
	expect(
		staleWriteBlock({
			displayPath: "src/auth.ts",
			stale: stale({ writers: [entry({ line: 4 })] }),
			currentText: null,
			now: NOW,
		}),
	).toBe(
		"Blocked: src/auth.ts changed since this agent read it (by You 4 s ago). Re-read before writing.",
	);
	expect(
		staleWriteBlock({
			displayPath: "a.ts",
			stale: stale({ untracked: true, script: { sessionId: "s2", self: false } }),
			currentText: null,
			now: NOW,
		}),
	).toContain("(by another agent's shell command)");
});

test("the diff is capped at 40 lines with a count of the rest", () => {
	const before = Array.from({ length: 60 }, (_, index) => `line ${index}\n`).join("");
	const after = Array.from({ length: 60 }, (_, index) => `LINE ${index}\n`).join("");
	const lines = renderDiff(before, after);
	expect(lines).toHaveLength(DIFF_MAX_LINES + 1);
	expect(lines.at(-1)).toBe("… 81 more diff lines not shown.");
});

test("the bash note lists each file the user saved during the call once", () => {
	const note = bashNote({
		userWrites: [
			entry({ path: "/w/src/auth.ts", at: NOW - 5000, line: 9 }),
			entry({ path: "/w/src/auth.ts", at: NOW - 3000, line: 12 }),
			entry({ path: "/w/README.md", at: NOW - 1000 }),
		],
		displayPath: (path) => path.replace("/w/", ""),
		now: NOW,
	});
	expect(note).toBe(
		[
			"Note: You edited src/auth.ts 3 s ago during this call (line 12).",
			"Note: You edited README.md 1 s ago during this call.",
		].join("\n"),
	);
	expect(bashNote({ userWrites: [], displayPath: String, now: NOW })).toBeNull();
});
