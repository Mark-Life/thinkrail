import { expect, test } from "bun:test";
import { conflictSpan, planConflictZones } from "./conflictLayout";

const conflict = { id: 1, from: 10, to: 20, theirs: "disk\n" };
const other = { id: 2, from: 30, to: 40, theirs: "other\n" };
const span = (startLine: number, theirsText = "disk") => ({
	startLine,
	endLine: startLine,
	theirsText,
});
const placed = [{ conflict, ...span(2) }];

test("a conflict that only moved inside its lines keeps its zone and takes the new offsets", () => {
	const moved = { ...conflict, from: 11, to: 21 };
	const plan = planConflictZones(placed, [{ conflict: moved, span: span(2) }]);
	expect(plan.unchanged).toBe(true);
	expect(plan.removed).toEqual([]);
	expect(plan.kept.get(1)?.conflict).toBe(moved);
});

test("other lines or other disk text replace the zone", () => {
	const lines = planConflictZones(placed, [{ conflict, span: span(3) }]);
	expect(lines).toMatchObject({ unchanged: false, removed: placed });
	const theirs = { ...conflict, theirs: "newer\n" };
	const text = planConflictZones(placed, [{ conflict: theirs, span: span(2, "newer") }]);
	expect(text).toMatchObject({ unchanged: false, removed: placed });
});

test("a new, gone or reordered conflict changes the layout but keeps the zones that still fit", () => {
	expect(planConflictZones(placed, [])).toMatchObject({ unchanged: false, removed: placed });
	expect(planConflictZones([], []).unchanged).toBe(true);
	const two = [...placed, { conflict: other, ...span(4, "other") }];
	const reordered = planConflictZones(two, [
		{ conflict: other, span: span(4, "other") },
		{ conflict, span: span(2) },
	]);
	expect(reordered.unchanged).toBe(false);
	expect(reordered.removed).toEqual([]);
	expect([...reordered.kept.keys()].sort()).toEqual([1, 2]);
	const added = planConflictZones(placed, [
		{ conflict, span: span(2) },
		{ conflict: other, span: span(4, "other") },
	]);
	expect(added).toMatchObject({ unchanged: false, removed: [] });
});

function textModel(text: string) {
	const lines = text.split("\n");
	return {
		getPositionAt(offset: number) {
			let rest = offset;
			for (const [index, line] of lines.entries()) {
				if (rest <= line.length) return { lineNumber: index + 1, column: rest + 1 };
				rest -= line.length + 1;
			}
			return { lineNumber: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
		},
		getValueLength: () => text.length,
		getLineMaxColumn: (lineNumber: number) => (lines[lineNumber - 1]?.length ?? 0) + 1,
	};
}

test("disk lines added after a last line with no newline sit below it, without a blank first line", () => {
	expect(conflictSpan(textModel("a\nb"), { id: 1, from: 3, to: 3, theirs: "\nC" })).toEqual({
		startLine: 3,
		endLine: null,
		theirsText: "C",
	});
	expect(conflictSpan(textModel("a"), { id: 1, from: 1, to: 1, theirs: "\nB\nc" })).toEqual({
		startLine: 2,
		endLine: null,
		theirsText: "B\nc",
	});
});

test("the same conflict with a final newline, and a line-start conflict, keep their lines", () => {
	expect(conflictSpan(textModel("a\nb\n"), { id: 1, from: 4, to: 4, theirs: "C\n" })).toEqual({
		startLine: 3,
		endLine: null,
		theirsText: "C",
	});
	expect(
		conflictSpan(textModel("a\nbX\nc\n"), { id: 1, from: 2, to: 5, theirs: "\nbY\n" }),
	).toEqual({ startLine: 2, endLine: 2, theirsText: "\nbY" });
	expect(conflictSpan(textModel("a\nX"), { id: 1, from: 1, to: 3, theirs: "" })).toEqual({
		startLine: 2,
		endLine: 2,
		theirsText: "",
	});
});
