import { expect, test } from "bun:test";
import type { StaleRead, WriteEntry } from "./ledger";
import { staleWriteBlock } from "./notes";

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

function block(overrides: Partial<StaleRead>, currentText: string | null = null, deleted = false) {
	return staleWriteBlock({
		displayPath: "src/auth.ts",
		stale: stale(overrides),
		currentText,
		now: NOW,
		deleted,
	});
}

function diffLines(before: string, after: string): string[] {
	return block({ writers: [entry({})], baselineText: before }, after)
		.split("\n")
		.slice(3, -1);
}

function age(ms: number): string {
	return block({ writers: [entry({ at: NOW - ms })] }).match(/by the user (.+)\)\./)?.[1] ?? "";
}

test("ages round to seconds, minutes and hours", () => {
	expect(age(4200)).toBe("4 s ago");
	expect(age(-50)).toBe("0 s ago");
	expect(age(3 * 60_000)).toBe("3 min ago");
	expect(age(2 * 3_600_000)).toBe("2 h ago");
});

test("the write block calls the agent you and names the writers and shells it may be", () => {
	expect(block({ writers: [entry({})] })).toBe(
		"Blocked: src/auth.ts changed since you read it (by the user 4 s ago). Re-read before writing.",
	);
	expect(block({ untracked: true, script: { self: false } })).toContain(
		"(by another agent's shell command, a terminal command or a program outside ThinkRail)",
	);
	expect(block({ untracked: true, script: { self: true } })).toContain(
		"(by your own shell command, a terminal command or a program outside ThinkRail)",
	);
	expect(block({ writers: [entry({ hash: null })] }, null, true)).toBe(
		"Blocked: src/auth.ts was deleted since you read it (by the user 4 s ago). Read it to confirm, then write again.",
	);
});

test("the write block diffs what the agent read against the file now", () => {
	expect(
		block({ writers: [entry({})], baselineText: "a\nttl = 60\nb\n" }, "a\nttl = 3600\nb\n"),
	).toBe(
		[
			"Blocked: src/auth.ts changed since you read it (by the user 4 s ago). Re-read before writing.",
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
	expect(
		block({
			writers: [
				entry({ at: NOW - 9000 }),
				entry({ at: NOW - 2000 }),
				entry({ author: { kind: "agent", sessionId: "s2", via: "tool", toolName: "edit" } }),
			],
			untracked: true,
		}),
	).toBe(
		"Blocked: src/auth.ts changed since you read it (by the user 2 s ago, another agent 4 s ago and a terminal command or a program outside ThinkRail). Re-read before writing.",
	);
});

test("a rewrite too large to diff says so instead of dropping the diff", () => {
	const before = Array.from({ length: 6000 }, (_, index) => `a${index}\n`).join("");
	const after = Array.from({ length: 6000 }, (_, index) => `b${index}\n`).join("");
	expect(block({ writers: [entry({})], baselineText: before }, after)).toEndWith(
		"Re-read before writing.\nThe changes are too large to show as a diff.",
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
	const text = block({ writers: [entry({})], baselineText: "a\n```\nb\n" }, "a\n```\nc\n");
	expect(text).toContain("\n````diff\n");
	expect(text).toEndWith("+c\n````");
});
