import { expect, test } from "bun:test";
import { createDoc, docChanges, docText, localChange, selectDoc } from "./history";

function typeAndSelect(steps: number) {
	let doc = createDoc("one\n");
	const first = new WeakRef(doc);
	for (let step = 0; step < steps; step += 1) {
		doc = localChange(doc, [{ from: 0, to: 0, insert: "x" }], "type");
		doc = selectDoc(doc, [{ anchor: step % 3, head: step % 3 }]);
	}
	return { first, doc };
}

test("a doc keeps no earlier state alive", async () => {
	const { first, doc } = typeAndSelect(200);
	expect(doc.doc.length).toBe(204);
	for (let round = 0; round < 3; round += 1) {
		Bun.gc(true);
		await Promise.resolve();
	}
	expect(first.deref()).toBeUndefined();
});

test("docChanges gives one step's changes, also past a selection, and null across more", () => {
	const start = createDoc("ab");
	const typed = localChange(start, [{ from: 1, to: 1, insert: "x" }], "type");
	const selected = selectDoc(typed, [{ anchor: 0, head: 0 }]);
	expect(docChanges(start, selected)).toEqual([{ from: 1, to: 1, insert: "x" }]);
	expect(docChanges(typed, selected)).toEqual([]);
	const again = localChange(selected, [{ from: 0, to: 0, insert: "y" }], "type");
	expect(docChanges(start, again)).toBeNull();
});

test("docText builds a doc's string once and follows every edit", () => {
	const doc = createDoc("one\n");
	const moved = selectDoc(doc, [{ anchor: 2, head: 2 }]);
	expect(docText(moved)).toBe(docText(doc));
	const typed = localChange(moved, [{ from: 0, to: 0, insert: "x" }], "type");
	expect(docText(typed)).toBe("xone\n");
});
