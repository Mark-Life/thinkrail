import { expect, test } from "bun:test";
import { toEditorText } from "@thinkrail/contracts";
import type { TextChange } from "@thinkrail/resource-renderers";
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
	expect(merged(both, both)).toMatchObject({ text: both, conflicts: [], changes: [] });
	const inserted = "one\ntwo\nnew\nthree\nfour\nfive\n";
	expect(merged(inserted, inserted).text).toBe(inserted);
});

test("a shared line is a conflict that keeps mine in the text", () => {
	const result = merged(
		"one\ntwo mine\nthree\nfour\nfive\n",
		"one\ntwo theirs\nthree\nfour\nfive\n",
	);
	expect(result.text).toBe("one\ntwo mine\nthree\nfour\nfive\n");
	expect(result.conflicts).toEqual([{ from: 4, to: 13, theirs: "two theirs\n" }]);
	const [conflict] = result.conflicts;
	expect(result.text.slice(conflict?.from, conflict?.to)).toBe("two mine\n");
});

test("deleting a line the other side edited is a conflict", () => {
	const mineDeletes = merged("one\nthree\nfour\nfive\n", "one\ntwo!\nthree\nfour\nfive\n");
	expect(mineDeletes.text).toBe("one\nthree\nfour\nfive\n");
	expect(mineDeletes.conflicts).toEqual([{ from: 4, to: 4, theirs: "two!\n" }]);
	const theirsDeletes = merged("one\ntwo!\nthree\nfour\nfive\n", "one\nthree\nfour\nfive\n");
	expect(theirsDeletes.conflicts).toEqual([{ from: 4, to: 9, theirs: "" }]);
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

test("same-point inserts that share lines keep each shared line once", () => {
	expect(merged("a\nX\n", "a\nX\nY\n", "a\n")).toMatchObject({
		text: "a\nX\nY\n",
		conflicts: [],
	});
	expect(merged("a\nA\nX\n", "a\nB\nX\n", "a\n").text).toBe("a\nA\nB\nX\n");
	const crossed = merged("a\nA\nX\n", "a\nX\nB\n", "a\n");
	expect(crossed.text).toBe("a\nA\nX\n");
	expect(crossed.conflicts).toEqual([{ from: 2, to: 6, theirs: "X\nB\n" }]);
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
	expect(result.conflicts).toEqual([{ from: 2, to: 6, theirs: "theirs" }]);
});

test("a conflict at the end of the text gives back exactly the disk tail", () => {
	const deleted = merged("a\n", "a\nb2", "a\nb\n");
	expect(deleted.text).toBe("a");
	expect(deleted.conflicts).toEqual([{ from: 1, to: 1, theirs: "\nb2" }]);
	expect(merged("", "y", "x").conflicts).toEqual([{ from: 0, to: 0, theirs: "y" }]);
	expect(merged("a\nb1\n", "a\nb2", "a\nb").conflicts).toEqual([{ from: 2, to: 5, theirs: "b2" }]);
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

function applyChanges(text: string, changes: readonly TextChange[]) {
	let out = "";
	let position = 0;
	for (const change of changes) {
		out += text.slice(position, change.from) + change.insert;
		position = change.to;
	}
	return out + text.slice(position);
}

test("the changes turn mine into the merged text, also around a missing last newline", () => {
	const variants = ["", "a", "a\n", "a\nb", "a\nb\n", "A\nb", "a\nB\n", "a\nb\nc", "x\na\nb", "b"];
	for (const base of variants) {
		for (const mine of variants) {
			for (const theirs of variants) {
				const result = merge3({ base, mine, theirs });
				if (result.kind !== "merged") throw new Error("merge fell back");
				expect(applyChanges(mine, result.changes)).toBe(result.text);
				for (const range of [...result.conflicts, ...result.touched]) {
					expect(range.to).toBeLessThanOrEqual(result.text.length);
				}
			}
		}
	}
});

test("changes hold only the disk side, trimmed inside the line", () => {
	const result = merged("ONE\ntwo\nthree\nfour\nfive\n", "one\ntwo\nthree\nfour\nfive!\n");
	expect(result.changes).toEqual([{ from: 23, to: 23, insert: "!" }]);
});

test("touched ranges cover every block the disk side changed, in merged text", () => {
	const result = merged("ONE\ntwo\nthree\nfour\nfive\n", "one\ntwo\nTHREE\nfour\nfive\n");
	expect(result.touched).toEqual([{ from: 8, to: 14 }]);
	const same = merged("one\nTWO\nthree\nfour\nfive\n", "one\nTWO\nthree\nfour\nfive\n");
	expect(same.touched).toEqual([{ from: 4, to: 8 }]);
	expect(merged("ONE\ntwo\nthree\nfour\nfive\n", BASE).touched).toEqual([]);
});
