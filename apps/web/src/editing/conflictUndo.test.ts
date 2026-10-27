import { expect, test } from "bun:test";
import {
	adoptDisk,
	type BufferState,
	beginSave,
	bufferStatus,
	bufferText,
	createBuffer,
	draftBaseHash,
	finishSave,
	localEdit,
	reloadFromDisk,
	resolveConflict,
	withDoc,
} from "./buffer";
import { canRedoDoc, canUndoDoc, conflictsOf, redoDoc, remoteText, undoDoc } from "./history";
import { textChanges } from "./textChanges";

const disk = (text: string) => ({ text, hash: `h:${text}` });
const edit = (state: BufferState, text: string) =>
	localEdit(state, textChanges(bufferText(state), text), "type");
const undo = (state: BufferState) => withDoc(state, undoDoc(state.doc));
const redo = (state: BufferState) => withDoc(state, redoDoc(state.doc));

const firstId = (state: BufferState) => {
	const [conflict] = conflictsOf(state.doc);
	if (!conflict) throw new Error("no open conflict");
	return conflict.id;
};

test("undoing my edit inside a conflict lands on the disk text, not the old base", () => {
	let state = createBuffer(disk("a\nb\nc\n"));
	state = edit(state, "a\nbX\nc\n");
	state = adoptDisk(state, disk("a\nbY\nc\n"));
	expect(bufferStatus(state)).toBe("conflict");
	state = undo(state);
	expect(bufferText(state)).toBe("a\nbY\nc\n");
	expect(conflictsOf(state.doc)).toEqual([]);
	expect(bufferStatus(state)).toBe("clean");
	expect(beginSave(state).request).toBeNull();
	expect(remoteText(state.doc, { text: bufferText(state), clear: true })).toBe(state.doc);
	state = redo(state);
	expect(bufferText(state)).toBe("a\nbYX\nc\n");
	expect(bufferStatus(state)).toBe("dirty");
});

test("undoing a deleted line that the disk edited brings the disk line back", () => {
	let state = createBuffer(disk("a\nb\nc\n"));
	state = edit(state, "a\nc\n");
	state = adoptDisk(state, disk("a\nbY\nc\n"));
	expect(conflictsOf(state.doc)).toHaveLength(1);
	state = undo(state);
	expect(bufferText(state)).toBe("a\nbY\nc\n");
	expect(bufferStatus(state)).toBe("clean");
});

test("typing a conflict's text into its disk version closes it, and undo opens it again", () => {
	let state = createBuffer(disk("a\nb\nc\n"));
	state = edit(state, "a\nbX\nc\n");
	state = adoptDisk(state, disk("a\nbY\nc\n"));
	state = localEdit(state, [{ from: 3, to: 4, insert: "Y" }], "paste");
	expect(bufferText(state)).toBe("a\nbY\nc\n");
	expect(bufferStatus(state)).toBe("clean");
	state = undo(state);
	expect(bufferText(state)).toBe("a\nbX\nc\n");
	expect(bufferStatus(state)).toBe("conflict");
});

test("Theirs on a last line the disk deleted gives exactly the disk text", () => {
	const clash = adoptDisk(edit(createBuffer(disk("a\nb")), "a\nB"), disk("a"));
	expect(bufferText(clash)).toBe("a\nB");
	expect(bufferText(resolveConflict(clash, firstId(clash), "theirs"))).toBe("a");
	expect(bufferStatus(resolveConflict(clash, firstId(clash), "theirs"))).toBe("clean");
	expect(bufferText(resolveConflict(clash, firstId(clash), "mine"))).toBe("a\nB");
	expect(bufferText(resolveConflict(clash, firstId(clash), "both"))).toBe("a\nB");
});

test("a conflict choice leaves the selection where the edit mapped it", () => {
	let state = createBuffer(disk("one\ntwo\n"));
	state = edit(state, "mine one\ntwo\n");
	state = adoptDisk(state, disk("theirs\ntwo\n"));
	const before = state.doc.selection.main.head;
	state = resolveConflict(state, firstId(state), "theirs");
	expect(state.doc.selection.main.head).toBe(Math.min(before, bufferText(state).length));
});

test("typing at the end of the line before a deleted last line stays out of its conflict", () => {
	let state = adoptDisk(edit(createBuffer(disk("a\nb")), "a\nB"), disk("a"));
	state = localEdit(state, [{ from: 1, to: 1, insert: "!" }], "other");
	expect(bufferText(resolveConflict(state, firstId(state), "theirs"))).toBe("a!");
});

test("undoing an unrelated delete next to a deleted-lines conflict leaves the conflict empty", () => {
	let state = createBuffer(disk("a\nb\nc\n"));
	state = localEdit(state, [{ from: 2, to: 4, insert: "" }], "delete");
	state = adoptDisk(state, disk("a\nbY\nc\n"));
	state = localEdit(state, [{ from: 2, to: 4, insert: "" }], "other");
	state = undo(state);
	expect(bufferText(state)).toBe("a\nc\n");
	expect(conflictsOf(state.doc)).toMatchObject([{ from: 2, to: 2, theirs: "bY\n" }]);
});

test("undo skips a Mine pick that a newer disk change replaced, and redo skips it too", () => {
	let state = createBuffer(disk("one\ntwo\n"));
	state = edit(state, "mine one\ntwo\n");
	state = adoptDisk(state, disk("theirs\ntwo\n"));
	state = resolveConflict(state, firstId(state), "mine");
	state = adoptDisk(state, disk("theirs2\ntwo\n"));
	const reopened = firstId(state);
	expect(bufferText(state)).toBe("mine one\ntwo\n");
	state = undo(state);
	expect(bufferText(state)).toBe("one\ntwo\n");
	expect(canUndoDoc(state.doc)).toBe(false);
	state = redo(state);
	expect(bufferText(state)).toBe("mine one\ntwo\n");
	expect(canRedoDoc(state.doc)).toBe(false);
	expect(conflictsOf(state.doc).map((conflict) => conflict.id)).toEqual([reopened]);
});

test("a disk text equal to the buffer is a no-op after a conflict was resolved", () => {
	let state = createBuffer(disk("a\nb\nc\n"));
	state = edit(state, "a\nbX\nc\n");
	state = adoptDisk(state, disk("a\nbY\nc\n"));
	state = resolveConflict(state, firstId(state), "mine");
	expect(remoteText(state.doc, { text: bufferText(state) })).toBe(state.doc);
	expect(remoteText(state.doc, { text: bufferText(state), clear: true })).not.toBe(state.doc);
});

const reloaded = (mine: string, theirs: string) => {
	let state = edit(createBuffer(disk("a\nb\nc\n")), mine);
	state = { ...state, issue: { kind: "conflict", disk: disk(theirs), typedOn: state.base.hash } };
	return reloadFromDisk(state);
};

test("a save after undoing Reload merges with the disk instead of overwriting it", () => {
	let state = undo(reloaded("a\nb\nc\nmine\n", "theirs\nb\nc\n"));
	expect(bufferText(state)).toBe("a\nb\nc\nmine\n");
	expect(draftBaseHash(state)).toBe("h:a\nb\nc\n");
	const { state: saving, request } = beginSave(state);
	expect(request?.expect.hash).toBe("h:a\nb\nc\n");
	const current = {
		content: "theirs\nb\nc\n",
		meta: { hash: "h:theirs", byteLength: 12, text: true },
	};
	state = finishSave(saving, { status: "stale", current });
	expect(bufferText(state)).toBe("theirs\nb\nc\nmine\n");
	expect(state.base.hash).toBe("h:theirs");
	expect(beginSave(state).request?.expect.hash).toBe("h:theirs");
});

test("undoing Reload over a line the disk also changed opens a conflict on save", () => {
	const { state: saving } = beginSave(undo(reloaded("A\nb\nc\n", "theirs\nb\nc\n")));
	const current = {
		content: "theirs\nb\nc\n",
		meta: { hash: "h:theirs", byteLength: 12, text: true },
	};
	const state = finishSave(saving, { status: "stale", current });
	expect(bufferStatus(state)).toBe("conflict");
	expect(conflictsOf(state.doc)).toMatchObject([{ theirs: "theirs\n" }]);
});

test("redo of Reload puts the text back on the disk version", () => {
	const state = redo(undo(reloaded("a\nb\nc\nmine\n", "theirs\nb\nc\n")));
	expect(bufferText(state)).toBe("theirs\nb\nc\n");
	expect(bufferStatus(state)).toBe("clean");
	expect(draftBaseHash(state)).toBe("h:theirs\nb\nc\n");
});

test("undoing Reload of a draft typed on an unknown version reopens the banner on save", () => {
	let state = edit(createBuffer(disk("theirs\n")), "mine\n");
	state = { ...state, issue: { kind: "conflict", disk: state.base, typedOn: "h:old" } };
	state = undo(reloadFromDisk(state));
	expect(bufferText(state)).toBe("mine\n");
	const { state: saving, request } = beginSave(state);
	expect(request?.expect.hash).toBe("h:old");
	const current = { content: "theirs\n", meta: { hash: "h:theirs\n", byteLength: 7, text: true } };
	state = finishSave(saving, { status: "stale", current });
	expect(bufferStatus(state)).toBe("stale");
	expect(bufferText(state)).toBe("mine\n");
});
