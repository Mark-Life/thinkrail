import { expect, test } from "bun:test";
import { Text } from "@codemirror/state";
import { toEditorText } from "@thinkrail/contracts";
import { merge3 } from "./merge3";

const BASE = "one\ntwo\nthree\nfour\nfive\n";

function merged(mine: string, theirs: string, base = BASE) {
	const result = merge3({ base, mine, theirs });
	if (result.kind !== "merged") throw new Error("merge fell back");
	return result;
}

test("edits on adjacent lines merge without a conflict", () => {
	const result = merged("one\nTWO\nthree\nfour\nfive\n", "one\ntwo\nTHREE\nfour\nfive\n");
	expect(result.text).toBe("one\nTWO\nTHREE\nfour\nfive\n");
	expect(result.conflicts).toEqual([]);
});

test("edits far apart both land", () => {
	expect(merged("ONE\ntwo\nthree\nfour\nfive\n", "one\ntwo\nthree\nfour\nFIVE\n").text).toBe(
		"ONE\ntwo\nthree\nfour\nFIVE\n",
	);
});

test("the same change on both sides lands once", () => {
	const both = "one\ntwo\n3\nfour\nfive\n";
	expect(merged(both, both)).toMatchObject({ text: both, conflicts: [] });
	expect(merged(both, both).changes.empty).toBe(true);
	const inserted = "one\ntwo\nnew\nthree\nfour\nfive\n";
	expect(merged(inserted, inserted).text).toBe(inserted);
});

test("a shared line is a conflict that keeps mine in the text", () => {
	const result = merged(
		"one\ntwo mine\nthree\nfour\nfive\n",
		"one\ntwo theirs\nthree\nfour\nfive\n",
	);
	expect(result.text).toBe("one\ntwo mine\nthree\nfour\nfive\n");
	expect(result.conflicts).toEqual([{ from: 4, to: 13, theirs: "two theirs\n", base: "two\n" }]);
	const [conflict] = result.conflicts;
	expect(result.text.slice(conflict?.from, conflict?.to)).toBe("two mine\n");
});

test("deleting a line the other side edited is a conflict", () => {
	const mineDeletes = merged("one\nthree\nfour\nfive\n", "one\ntwo!\nthree\nfour\nfive\n");
	expect(mineDeletes.text).toBe("one\nthree\nfour\nfive\n");
	expect(mineDeletes.conflicts).toEqual([{ from: 4, to: 4, theirs: "two!\n", base: "two\n" }]);
	const theirsDeletes = merged("one\ntwo!\nthree\nfour\nfive\n", "one\nthree\nfour\nfive\n");
	expect(theirsDeletes.conflicts).toEqual([{ from: 4, to: 9, theirs: "", base: "two\n" }]);
});

test("a delete next to an edit merges", () => {
	expect(merged("one\nthree\nfour\nfive\n", "one\ntwo\nTHREE\nfour\nfive\n").text).toBe(
		"one\nTHREE\nfour\nfive\n",
	);
});

test("inserts at the same point keep mine first; an insert inside an edit conflicts", () => {
	const result = merged(
		"one\nmine\ntwo\nthree\nfour\nfive\n",
		"one\ntheirs\ntwo\nthree\nfour\nfive\n",
	);
	expect(result.text).toBe("one\nmine\ntheirs\ntwo\nthree\nfour\nfive\n");
	expect(result.conflicts).toEqual([]);
	const inside = merged("one\ntwo\nadded\nthree\nfour\nfive\n", "one\nTWO\nTHREE\nfour\nfive\n");
	expect(inside.conflicts).toHaveLength(1);
});

test("same-point inserts where one contains the other keep the longer one", () => {
	expect(merged("a\nX\n", "a\nX\nY\n", "a\n")).toMatchObject({
		text: "a\nX\nY\n",
		conflicts: [],
	});
	expect(merged("a\nY\nX\n", "a\nX\n", "a\n").text).toBe("a\nY\nX\n");
});

test("same-point inserts that share only some lines conflict", () => {
	const result = merged("a\nfunction x() {\n}\n", "a\nfunction y() {\n}\n", "a\n");
	expect(result.text).toBe("a\nfunction x() {\n}\n");
	expect(result.conflicts).toEqual([{ from: 2, to: 19, theirs: "function y() {\n}\n", base: "" }]);
	const crossed = merged("a\nA\nX\n", "a\nX\nB\n", "a\n");
	expect(crossed.conflicts).toEqual([{ from: 2, to: 6, theirs: "X\nB\n", base: "" }]);
});

test("an insert at the edge of the other side's edit merges", () => {
	expect(merged("one\ntwo\nadded\nthree\nfour\nfive\n", "one\nTWO\nthree\nfour\nfive\n").text).toBe(
		"one\nTWO\nadded\nthree\nfour\nfive\n",
	);
});

test("a last line without a newline merges with lines added after it", () => {
	expect(merged("a\nB", "a\nb\nc", "a\nb").text).toBe("a\nB\nc");
	expect(merged("A\nb", "a\nb\n", "a\nb").text).toBe("A\nb\n");
	expect(merged("a\nb\nc", "a\nb", "a\nb").text).toBe("a\nb\nc");
});

test("a conflict on a last line without a newline keeps both forms", () => {
	const result = merged("a\nmine", "a\ntheirs", "a\nb");
	expect(result.text).toBe("a\nmine");
	expect(result.conflicts).toEqual([{ from: 2, to: 6, theirs: "theirs", base: "b\n" }]);
});

test("a conflict at the end of the text gives back exactly the disk tail", () => {
	const deleted = merged("a\n", "a\nb2", "a\nb\n");
	expect(deleted.text).toBe("a");
	expect(deleted.conflicts).toEqual([{ from: 1, to: 1, theirs: "\nb2" }]);
	expect(merged("", "y", "x").conflicts).toEqual([{ from: 0, to: 0, theirs: "y", base: "x\n" }]);
	expect(merged("a\nb1\n", "a\nb2", "a\nb").conflicts).toEqual([
		{ from: 2, to: 5, theirs: "b2", base: "b\n" },
	]);
});

test("CRLF disk text merges once it is in editor form", () => {
	const theirs = toEditorText("one\r\ntwo\r\nthree\r\nfour\r\nFIVE\r\n");
	expect(merged("ONE\ntwo\nthree\nfour\nfive\n", theirs).text).toBe(
		"ONE\ntwo\nthree\nfour\nFIVE\n",
	);
});

test("empty texts merge", () => {
	expect(merged("", "", "").text).toBe("");
	expect(merged("a\n", "", "").text).toBe("a\n");
	expect(merged("", "b\n", "").text).toBe("b\n");
});

test("a merge past the diff budget falls back", () => {
	const lines = Array.from({ length: 3000 }, (_, index) => `line ${index}\n`);
	const base = lines.join("");
	const mine = lines.map((line, index) => (index % 2 === 0 ? `mine ${line}` : line)).join("");
	expect(merge3({ base, mine, theirs: base })).toEqual({ kind: "tooLarge" });
});

test("the changes turn mine into the merged text, also around a missing last newline", () => {
	const variants = ["", "a", "a\n", "a\nb", "a\nb\n", "A\nb", "a\nB\n", "a\nb\nc", "x\na\nb", "b"];
	for (const base of variants) {
		for (const mine of variants) {
			for (const theirs of variants) {
				const result = merge3({ base, mine, theirs });
				if (result.kind !== "merged") throw new Error("merge fell back");
				expect(result.changes.apply(Text.of(mine.split("\n"))).toString()).toBe(result.text);
				for (const range of [...result.conflicts, ...result.touched]) {
					expect(range.to).toBeLessThanOrEqual(result.text.length);
				}
			}
		}
	}
});

test("changes hold only the disk side, trimmed inside the line", () => {
	const result = merged("ONE\ntwo\nthree\nfour\nfive\n", "one\ntwo\nthree\nfour\nfive!\n");
	expect(result.changes.toJSON()).toEqual([23, [0, "!"], 1]);
});

test("touched ranges cover every block the disk side changed, in merged text", () => {
	const result = merged("ONE\ntwo\nthree\nfour\nfive\n", "one\ntwo\nTHREE\nfour\nfive\n");
	expect(result.touched).toEqual([{ from: 8, to: 14 }]);
	const same = merged("one\nTWO\nthree\nfour\nfive\n", "one\nTWO\nthree\nfour\nfive\n");
	expect(same.touched).toEqual([{ from: 4, to: 8 }]);
	expect(merged("ONE\ntwo\nthree\nfour\nfive\n", BASE).touched).toEqual([]);
});

test("both sides editing one of two equal lines is a conflict, not two inserts", () => {
	const pair = merge3({ base: "a\na\n", mine: "b\na\n", theirs: "c\na\n" });
	expect(pair).toMatchObject({ text: "b\na\n", conflicts: [{ from: 0, to: 2, theirs: "c\n" }] });
	const blank = merged("x\nmine\n\ny\n", "x\ntheirs\n\ny\n", "x\n\n\ny\n");
	expect(blank.text).toBe("x\nmine\n\ny\n");
	expect(blank.conflicts).toEqual([{ from: 2, to: 7, theirs: "theirs\n", base: "\n" }]);
	const brace = merged(
		"if (a) {\n  f();\n};\n}\n",
		"if (a) {\n  f();\n} // done\n}\n",
		"if (a) {\n  f();\n}\n}\n",
	);
	expect(brace.text).toBe("if (a) {\n  f();\n};\n}\n");
	expect(brace.conflicts).toHaveLength(1);
});

test("a delete inside a run of equal lines merges with the other side's edit nearby", () => {
	expect(merged("a\nx\nx\nB\n", "A\nx\nx\nb\n", "a\nx\nx\nx\nb\n").text).toBe("A\nx\nx\nB\n");
});

test("a disk that deletes a last line without a newline gives a conflict whose Theirs drops it", () => {
	const result = merged("a\nB", "a", "a\nb");
	expect(result.text).toBe("a\nB");
	expect(result.conflicts).toEqual([{ from: 1, to: 3, theirs: "", base: "\nb\n" }]);
});

test("disk lines after a last line mine deleted, with no final newline, insert after that line", () => {
	const result = merged("a\nb", "a\nb\nC", "a\nb\nc");
	expect(result.text).toBe("a\nb");
	expect(result.conflicts).toEqual([{ from: 3, to: 3, theirs: "\nC" }]);
});
