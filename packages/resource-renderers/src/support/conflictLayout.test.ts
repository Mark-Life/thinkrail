import { expect, test } from "bun:test";
import { sameConflictLayout } from "./conflictLayout";

const conflict = { id: 1, from: 10, to: 20, theirs: "disk\n" };
const placed = [{ conflict, startLine: 2, endLine: 2 }];

test("a conflict that only moved inside its lines keeps its layout", () => {
	const moved = { ...conflict, from: 11, to: 21 };
	expect(
		sameConflictLayout(placed, [{ conflict: moved, span: { startLine: 2, endLine: 2 } }]),
	).toBe(true);
});

test("other lines, other disk text, or another set of conflicts change the layout", () => {
	expect(sameConflictLayout(placed, [{ conflict, span: { startLine: 3, endLine: 3 } }])).toBe(
		false,
	);
	const theirs = { ...conflict, theirs: "newer\n" };
	expect(
		sameConflictLayout(placed, [{ conflict: theirs, span: { startLine: 2, endLine: 2 } }]),
	).toBe(false);
	expect(sameConflictLayout(placed, [])).toBe(false);
	expect(sameConflictLayout([], [])).toBe(true);
});
