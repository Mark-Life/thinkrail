import { describe, expect, test } from "bun:test";
import { foldUnchanged, sideBySide } from "./lineDiff";

describe("sideBySide", () => {
	test("pairs a replacement on one row", () => {
		const rows = sideBySide({
			before: "a\nb\nc\n",
			after: "a\nX\nc\n",
			beforeStart: 10,
			afterStart: 20,
		});
		expect(rows.map((row) => row.kind)).toEqual(["same", "change", "same"]);
		const change = rows[1];
		if (change?.kind !== "change") throw new Error("expected change");
		expect(change.left).toEqual({ line: 11, text: "b" });
		expect(change.right).toEqual({ line: 21, text: "X" });
	});

	test("keeps extra added and removed lines apart", () => {
		const added = sideBySide({ before: "a\n", after: "a\nb\nc\n", beforeStart: 1, afterStart: 1 });
		expect(added.map((row) => row.kind)).toEqual(["same", "add", "add"]);
		const removed = sideBySide({
			before: "a\nb\nc\n",
			after: "a\n",
			beforeStart: 1,
			afterStart: 1,
		});
		expect(removed.map((row) => row.kind)).toEqual(["same", "remove", "remove"]);
	});

	test("handles an empty side", () => {
		const rows = sideBySide({ before: "", after: "new\n", beforeStart: 1, afterStart: 5 });
		expect(rows).toEqual([{ kind: "add", right: { line: 5, text: "new" } }]);
	});
});

describe("foldUnchanged", () => {
	test("folds long unchanged runs and keeps context", () => {
		const before = Array.from({ length: 30 }, (_, line) => `l${line}`).join("\n");
		const after = before.replace("l15", "changed");
		const rows = sideBySide({ before, after, beforeStart: 1, afterStart: 1 });
		const display = foldUnchanged({ rows, context: 2 });
		const kinds = display.map((row) => row.kind);
		expect(kinds.filter((kind) => kind === "fold")).toHaveLength(2);
		expect(kinds.filter((kind) => kind === "same")).toHaveLength(4);
		const hidden = display.reduce((sum, row) => sum + (row.kind === "fold" ? row.hidden : 0), 0);
		expect(hidden + 5).toBe(rows.length);
	});
});
