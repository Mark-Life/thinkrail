import { expect, test } from "bun:test";
import { planConflictZones } from "./conflictLayout";

const conflict = { id: 1, from: 10, to: 20, theirs: "disk\n" };
const other = { id: 2, from: 30, to: 40, theirs: "other\n" };
const placed = [{ conflict, startLine: 2, endLine: 2 }];

test("a conflict that only moved inside its lines keeps its zone and takes the new offsets", () => {
	const moved = { ...conflict, from: 11, to: 21 };
	const plan = planConflictZones(placed, [{ conflict: moved, span: { startLine: 2, endLine: 2 } }]);
	expect(plan.unchanged).toBe(true);
	expect(plan.removed).toEqual([]);
	expect(plan.kept.get(1)?.conflict).toBe(moved);
});

test("other lines or other disk text replace the zone", () => {
	const lines = planConflictZones(placed, [{ conflict, span: { startLine: 3, endLine: 3 } }]);
	expect(lines).toMatchObject({ unchanged: false, removed: placed });
	const theirs = { ...conflict, theirs: "newer\n" };
	const text = planConflictZones(placed, [
		{ conflict: theirs, span: { startLine: 2, endLine: 2 } },
	]);
	expect(text).toMatchObject({ unchanged: false, removed: placed });
});

test("a new, gone or reordered conflict changes the layout but keeps the zones that still fit", () => {
	expect(planConflictZones(placed, [])).toMatchObject({ unchanged: false, removed: placed });
	expect(planConflictZones([], []).unchanged).toBe(true);
	const two = [...placed, { conflict: other, startLine: 4, endLine: 4 }];
	const reordered = planConflictZones(two, [
		{ conflict: other, span: { startLine: 4, endLine: 4 } },
		{ conflict, span: { startLine: 2, endLine: 2 } },
	]);
	expect(reordered.unchanged).toBe(false);
	expect(reordered.removed).toEqual([]);
	expect([...reordered.kept.keys()].sort()).toEqual([1, 2]);
	const added = planConflictZones(placed, [
		{ conflict, span: { startLine: 2, endLine: 2 } },
		{ conflict: other, span: { startLine: 4, endLine: 4 } },
	]);
	expect(added).toMatchObject({ unchanged: false, removed: [] });
});
