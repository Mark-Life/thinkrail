import { expect, test } from "bun:test";
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
	expect(result).toEqual({ kind: "merged", text: "one\nTWO\nTHREE\nfour\nfive\n", conflicts: [] });
});

test("edits far apart both land", () => {
	expect(merged("ONE\ntwo\nthree\nfour\nfive\n", "one\ntwo\nthree\nfour\nFIVE\n").text).toBe(
		"ONE\ntwo\nthree\nfour\nFIVE\n",
	);
});

test("the same change on both sides lands once", () => {
	const both = "one\ntwo\n3\nfour\nfive\n";
	expect(merged(both, both)).toEqual({ kind: "merged", text: both, conflicts: [] });
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
	expect(result).toEqual({
		kind: "merged",
		text: "one\nmine\ntheirs\ntwo\nthree\nfour\nfive\n",
		conflicts: [],
	});
	const inside = merged("one\ntwo\nadded\nthree\nfour\nfive\n", "one\nTWO\nTHREE\nfour\nfive\n");
	expect(inside.conflicts).toHaveLength(1);
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
