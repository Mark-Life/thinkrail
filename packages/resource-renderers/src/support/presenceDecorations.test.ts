import { describe, expect, test } from "bun:test";
import {
	diffFence,
	htmlAttribute,
	markdownText,
	PRESENCE_TIMING,
	presencePaint,
	presencePhase,
} from "./presenceDecorations";

const LINES = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
const TEXT = `${LINES.join("\n")}\n`;
const offsetOf = (line: number) =>
	LINES.slice(0, line - 1).reduce((sum, l) => sum + l.length + 1, 0);

describe("presencePaint", () => {
	test("a one-line replace marks that line and diffs it", () => {
		const from = offsetOf(3);
		const paint = presencePaint({
			before: TEXT,
			changes: [{ from, to: from + "line 3\n".length, insert: "LINE 3\n" }],
		});
		expect(paint).toEqual({
			kind: "lines",
			spans: [{ startLine: 3, endLine: 3 }],
			diff: ["- line 3", "+ LINE 3"],
		});
	});

	test("ranges land in post-change lines, after earlier inserts shift them", () => {
		const paint = presencePaint({
			before: TEXT,
			changes: [
				{ from: offsetOf(10), to: offsetOf(10) + 7, insert: "ten\n" },
				{ from: 0, to: 0, insert: "a\nb\n" },
			],
		});
		expect(paint?.kind === "lines" && paint.spans).toEqual([
			{ startLine: 1, endLine: 2 },
			{ startLine: 12, endLine: 12 },
		]);
	});

	test("a deletion marks the line where the text went, and adjacent changes join", () => {
		const paint = presencePaint({
			before: TEXT,
			changes: [
				{ from: offsetOf(5), to: offsetOf(6), insert: "" },
				{ from: offsetOf(6), to: offsetOf(7), insert: "six!\n" },
			],
		});
		expect(paint).toEqual({
			kind: "lines",
			spans: [{ startLine: 5, endLine: 5 }],
			diff: ["- line 5", "- line 6", "+ six!"],
		});
	});

	test("an insert after a line break starts on the new line", () => {
		const end = offsetOf(2) - 1;
		const paint = presencePaint({
			before: TEXT,
			changes: [{ from: end, to: end, insert: "\nnew" }],
		});
		expect(paint?.kind === "lines" && paint.spans).toEqual([{ startLine: 2, endLine: 2 }]);
	});

	test("a write changing more than half of the file is one file mark", () => {
		const paint = presencePaint({
			before: TEXT,
			changes: [{ from: 0, to: offsetOf(12), insert: "x\n".repeat(11) }],
		});
		expect(paint).toEqual({ kind: "file", changedLines: 11, totalLines: 20 });
	});

	test("a small file keeps line marks even when most of it changed", () => {
		const paint = presencePaint({
			before: "a\nb\n",
			changes: [{ from: 0, to: 4, insert: "c\nd\n" }],
		});
		expect(paint?.kind).toBe("lines");
	});

	test("no change paints nothing", () => {
		expect(presencePaint({ before: TEXT, changes: [] })).toBeNull();
	});

	test("the diff is capped in lines and characters", () => {
		const long = "y".repeat(400);
		const paint = presencePaint({
			before: TEXT,
			changes: [{ from: 0, to: offsetOf(8), insert: `${long}\n`.repeat(7) }],
		});
		expect(paint?.kind).toBe("lines");
		if (paint?.kind !== "lines") return;
		expect(paint.diff).toHaveLength(12);
		expect(paint.diff[0]).toBe("- line 1");
		expect(paint.diff.every((line) => line.length <= 163)).toBe(true);
	});
});

describe("presencePhase", () => {
	test("the wash fades first, then the flag, then the chip, then the bar", () => {
		expect(presencePhase(0, 0)).toEqual({ wash: true, flag: true, chip: true, bar: true });
		expect(presencePhase(0, PRESENCE_TIMING.washMs)).toMatchObject({ wash: false, flag: true });
		expect(presencePhase(0, PRESENCE_TIMING.flagMs)).toMatchObject({ flag: false, chip: true });
		expect(presencePhase(0, PRESENCE_TIMING.chipMs)).toMatchObject({ chip: false, bar: true });
		expect(presencePhase(0, PRESENCE_TIMING.holdMs).bar).toBe(false);
	});
});

describe("hover text", () => {
	test("labels are escaped and the fence outgrows any backtick run", () => {
		expect(markdownText("Agent · *fix* [x]")).toBe("Agent · \\*fix\\* \\[x\\]");
		expect(diffFence(["+ a ```` b"])).toBe("`````diff\n+ a ```` b\n`````");
		expect(diffFence(["- a"])).toBe("```diff\n- a\n```");
		expect(htmlAttribute('Agent · "<b>" & co')).toBe("Agent · &quot;&lt;b&gt;&quot; &amp; co");
	});
});
