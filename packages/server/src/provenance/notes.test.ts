import { expect, test } from "bun:test";
import type { StaleRead, WriteEntry } from "./ledger";
import { bashNote, overwriteNote, staleEditHint, staleWriteBlock } from "./notes";
import { firstChangedLine } from "./snapshot";

const NOW = 100_000;

function entry(overrides: Partial<WriteEntry>): WriteEntry {
	return {
		seq: 1,
		at: NOW - 4000,
		key: "/w/src/auth.ts",
		path: "/w/src/auth.ts",
		hash: "h",
		author: { kind: "user", clientKey: "c" },
		...overrides,
	};
}

function stale(overrides: Partial<StaleRead>): StaleRead {
	return {
		read: true,
		writers: [],
		untracked: false,
		...overrides,
	};
}

function diffLines(before: string, after: string): string[] {
	const text = staleEditHint({
		displayPath: "a.ts",
		stale: stale({ writers: [entry({})], baselineText: before }),
		currentText: after,
		now: NOW,
	});
	return text.split("\n").slice(3, -1);
}

function age(ms: number): string {
	const note = bashNote({
		userWrites: [entry({ at: NOW - ms })],
		displayPath: () => "a.ts",
		now: NOW,
	});
	return note?.match(/a\.ts (.+) during/)?.[1] ?? "";
}

test("ages round to seconds, minutes and hours", () => {
	expect(age(4200)).toBe("4 s ago");
	expect(age(-50)).toBe("0 s ago");
	expect(age(3 * 60_000)).toBe("3 min ago");
	expect(age(2 * 3_600_000)).toBe("2 h ago");
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
			"ThinkRail: src/auth.ts was changed by the user 4 s ago (line 10) since you last read it. Re-read the file before editing.",
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
		"ThinkRail: a.ts was changed by the user 2 s ago (line 3), another agent 4 s ago and a terminal command or a program outside ThinkRail since you last read it. Re-read the file before editing.",
	);
});

test("a hint without a baseline has no since clause and no diff", () => {
	const text = staleEditHint({
		displayPath: "a.ts",
		stale: stale({ read: false, writers: [entry({ line: 2 })] }),
		currentText: "x\n",
		now: NOW,
	});
	expect(text).toBe(
		"ThinkRail: a.ts was changed by the user 4 s ago (line 2). Re-read the file before editing.",
	);
});

test("the write block calls the agent you and names the writers and shells it may be", () => {
	const block = (overrides: Partial<StaleRead>, deleted = false) =>
		staleWriteBlock({
			displayPath: "src/auth.ts",
			stale: stale(overrides),
			currentText: null,
			now: NOW,
			deleted,
		});
	expect(block({ writers: [entry({ line: 4 })] })).toBe(
		"Blocked: src/auth.ts changed since you read it (by the user 4 s ago). Re-read before writing.",
	);
	expect(block({ untracked: true, script: { self: false } })).toContain(
		"(by another agent's shell command, a terminal command or a program outside ThinkRail)",
	);
	expect(block({ untracked: true, script: { self: true } })).toContain(
		"(by your own shell command, a terminal command or a program outside ThinkRail)",
	);
	expect(block({ writers: [entry({ hash: null })] }, true)).toBe(
		"Blocked: src/auth.ts was deleted since you read it (by the user 4 s ago). Read it to confirm, then write again.",
	);
});

test("the overwrite note names who was replaced and diffs their version against the file now", () => {
	const note = overwriteNote({
		displayPath: "a.ts",
		overwrite: { writers: [entry({ line: 2 })], text: "a\nuser\n" },
		currentText: "a\nagent\n",
		now: NOW,
	});
	expect(note).toBe(
		[
			"ThinkRail: a.ts was changed by the user 4 s ago (line 2) after this write was checked, so this write replaced that change. Re-read the file and restore it if it should stay.",
			"What this write replaced (- before this write, + the file now):",
			"```diff",
			"@@ -1,2 +1,2 @@",
			" a",
			"-user",
			"+agent",
			"```",
		].join("\n"),
	);
	expect(
		overwriteNote({
			displayPath: "a.ts",
			overwrite: { writers: [entry({})] },
			currentText: "x",
			now: NOW,
		}),
	).toEndWith("restore it if it should stay.");
});

test("a rewrite too large to diff says so instead of dropping the diff", () => {
	const before = Array.from({ length: 6000 }, (_, index) => `a${index}\n`).join("");
	const after = Array.from({ length: 6000 }, (_, index) => `b${index}\n`).join("");
	const text = staleEditHint({
		displayPath: "a.ts",
		stale: stale({ writers: [entry({})], baselineText: before }),
		currentText: after,
		now: NOW,
	});
	expect(text).toEndWith(
		"Re-read the file before editing.\nThe changes are too large to show as a diff.",
	);
});

test("a formatter run over a large file gives up on the diff fast", () => {
	const lines = Array.from({ length: 15_000 }, (_, index) => `const value${index} = ${index};`);
	const before = `${lines.join("\n")}\n`;
	const after = `${lines.map((line, index) => (index % 3 === 0 ? `${line} // x` : line)).join("\n")}\n`;
	const started = performance.now();
	const text = staleWriteBlock({
		displayPath: "a.ts",
		stale: stale({ untracked: true, baselineText: before }),
		currentText: after,
		now: NOW,
		deleted: false,
	});
	expect(performance.now() - started).toBeLessThan(2000);
	expect(text).toEndWith("\nThe changes are too large to show as a diff.");
});

test("the diff is capped at 40 lines with a count of the rest", () => {
	const before = Array.from({ length: 60 }, (_, index) => `line ${index}\n`).join("");
	const after = Array.from({ length: 60 }, (_, index) => `LINE ${index}\n`).join("");
	const lines = diffLines(before, after);
	expect(lines).toHaveLength(41);
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
			"Note: the user edited src/auth.ts 3 s ago during this call (line 12).",
			"Note: the user edited README.md 1 s ago during this call.",
		].join("\n"),
	);
	expect(bashNote({ userWrites: [], displayPath: String, now: NOW })).toBeNull();
});

test("a minified line is clipped and the whole diff stays under its character budget", () => {
	const line = "x".repeat(400_000);
	const lines = diffLines(`${line}\n`, `${line}y\n`);
	expect(lines.every((diffLine) => diffLine.length < 240 + 40)).toBe(true);
	expect(lines[1]).toEndWith("… (399761 more chars)");
	const many = diffLines(
		Array.from({ length: 30 }, (_, index) => `${"a".repeat(300)}${index}\n`).join(""),
		Array.from({ length: 30 }, (_, index) => `${"b".repeat(300)}${index}\n`).join(""),
	);
	expect(many.join("\n").length).toBeLessThan(7000);
	expect(many.at(-1)).toMatch(/^… \d+ more diff lines not shown\.$/);
});

test("the diff fence is longer than any backtick run in the file", () => {
	const text = staleEditHint({
		displayPath: "README.md",
		stale: stale({ writers: [entry({})], baselineText: "a\n```\nb\n" }),
		currentText: "a\n```\nc\n",
		now: NOW,
	});
	expect(text).toContain("\n````diff\n");
	expect(text).toEndWith("+c\n````");
});

test("the bash note says when the user deleted a file", () => {
	expect(
		bashNote({
			userWrites: [entry({ path: "/w/old.ts", hash: null, at: NOW })],
			displayPath: (path) => path.replace("/w/", ""),
			now: NOW,
		}),
	).toBe("Note: the user deleted old.ts 0 s ago during this call.");
});
