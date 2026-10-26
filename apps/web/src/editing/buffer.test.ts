import { expect, test } from "bun:test";
import { FILE_WRITE_MAX_BYTES, type FileContent, LFS_POINTER_MIME } from "@thinkrail/contracts";
import {
	adoptDisk,
	type BufferState,
	beginSave,
	bufferStatus,
	bufferSummary,
	createBuffer,
	draftBaseHash,
	editorDisk,
	failSave,
	finishSave,
	keepMine,
	localEdit,
	markError,
	markMissing,
	reloadFromDisk,
	restoreDraft,
} from "./buffer";
import { docText, undoDoc } from "./history";
import { textChanges } from "./textChanges";

const disk = (text: string, hash = `h:${text}`) => ({ text, hash });
const edit = (state: BufferState, text: string) =>
	localEdit(state, textChanges(state.text, text), "type");
const file = (content: string, hash: string, mime?: string): FileContent => ({
	content,
	meta: { hash, byteLength: content.length, text: true, ...(mime ? { mime } : {}) },
});

test("disk text is adopted in editor form, and never from non-text or LFS metadata", () => {
	expect(editorDisk(file("﻿a\r\nb", "h1"))).toEqual({ text: "a\nb", hash: "h1" });
	expect(editorDisk(file("oid", "h2", LFS_POINTER_MIME))).toBeNull();
	expect(editorDisk({ content: "", meta: { hash: "h3", byteLength: 3, text: false } })).toBeNull();
});

test("status follows dirtiness, a write in flight and the issue precedence", () => {
	const clean = createBuffer(disk("a"));
	expect(bufferStatus(clean)).toBe("clean");
	const dirty = edit(clean, "ab");
	expect(bufferSummary(dirty)).toEqual({ status: "dirty", dirty: true });
	const saving = beginSave(dirty).state;
	expect(bufferStatus(saving)).toBe("saving");
	expect(bufferStatus(markMissing(dirty))).toBe("deleted");
	expect(bufferStatus(adoptDisk(dirty, disk("theirs")))).toBe("conflict");
	expect(bufferStatus(restoreDraft(clean, { text: "x", baseHash: "h:old" }))).toBe("stale");
	expect(bufferStatus(finishSave(saving, { status: "readonly" }))).toBe("readonly");
});

test("a disk change replaces a clean buffer and merges into a dirty one", () => {
	const clean = createBuffer(disk("a"));
	expect(adoptDisk(clean, disk("b"))).toMatchObject({ text: "b", base: disk("b"), issue: null });
	const dirty = edit(createBuffer(disk("one\ntwo\n")), "ONE\ntwo\n");
	const merged = adoptDisk(dirty, disk("one\nTWO\n"));
	expect(merged).toMatchObject({ text: "ONE\nTWO\n", base: disk("one\nTWO\n"), issue: null });
	expect(bufferSummary(merged)).toEqual({ status: "dirty", dirty: true });
	const clash = adoptDisk(dirty, disk("uno\ntwo\n"));
	expect(clash.text).toBe("ONE\ntwo\n");
	expect(clash.base).toEqual(disk("uno\ntwo\n"));
	expect(bufferSummary(clash)).toEqual({ status: "conflict", dirty: true, conflicts: 1 });
	expect(adoptDisk(dirty, disk("ONE\ntwo\n"))).toMatchObject({
		base: disk("ONE\ntwo\n"),
		issue: null,
	});
});

test("the same hash as the base is a no-op, which hides the echo of our own save", () => {
	const dirty = edit(createBuffer(disk("a")), "b");
	expect(adoptDisk(dirty, disk("a"))).toBe(dirty);
});

test("a disk that moves back to the base clears an outdated conflict", () => {
	const moved = restoreDraft(createBuffer(disk("a")), { text: "mine", baseHash: "h:old" });
	const newer = adoptDisk(moved, disk("b"));
	expect(newer.issue).toMatchObject({ kind: "conflict", disk: disk("b") });
	expect(adoptDisk(newer, disk("a")).issue).toBeNull();
});

test("Reload takes the disk version as an undoable step and Keep mine keeps the text", () => {
	const draft = restoreDraft(createBuffer(disk("a")), { text: "mine", baseHash: "h:old" });
	const stale = adoptDisk(draft, disk("theirs"));
	const reloaded = reloadFromDisk(stale);
	expect(reloaded).toMatchObject({ text: "theirs", base: disk("theirs"), issue: null });
	expect(docText(undoDoc(reloaded.doc))).toBe("mine");
	const kept = keepMine(stale);
	expect(kept).toMatchObject({ text: "mine", base: disk("theirs"), issue: null });
	expect(beginSave(kept).request).toEqual({ content: "mine", expect: { hash: "h:theirs" } });
});

test("saving sends the text against the base hash, and only when there is something to write", () => {
	const clean = createBuffer(disk("a"));
	expect(beginSave(clean).request).toBeNull();
	const dirty = edit(clean, "b");
	const { state, request } = beginSave(dirty);
	expect(request).toEqual({ content: "b", expect: { hash: "h:a" } });
	expect(beginSave(state).request).toBeNull();
	const stale = adoptDisk(dirty, disk("theirs"));
	expect(beginSave(stale).request).toBeNull();
});

test("a deleted buffer saves as a create, even when its text is unchanged", () => {
	const deleted = markMissing(createBuffer(disk("a")));
	expect(bufferSummary(deleted)).toEqual({ status: "deleted", dirty: false });
	expect(beginSave(deleted).request).toEqual({ content: "a", expect: { hash: null } });
});

test("content over the write cap is refused before sending", () => {
	const big = edit(createBuffer(disk("a")), "x".repeat(FILE_WRITE_MAX_BYTES + 1));
	const { state, request } = beginSave(big);
	expect(request).toBeNull();
	expect(bufferSummary(state)).toEqual({ status: "error", dirty: true, error: "tooLarge" });
});

test("a written save moves the base to the sent text and keeps later typing dirty", () => {
	const saving = beginSave(edit(createBuffer(disk("a")), "b")).state;
	const typedMore = edit(saving, "bc");
	const written = finishSave(typedMore, {
		status: "written",
		meta: { hash: "h:b", byteLength: 1, text: true },
	});
	expect(written).toMatchObject({ text: "bc", base: disk("b"), saving: null });
	expect(bufferStatus(written)).toBe("dirty");
});

test("a stale save merges the disk version, and a binary one is not editable", () => {
	const saving = beginSave(edit(createBuffer(disk("one\ntwo\n")), "ONE\ntwo\n")).state;
	const merged = finishSave(saving, { status: "stale", current: file("one\r\nTWO\r\n", "h9") });
	expect(merged).toMatchObject({
		text: "ONE\nTWO\n",
		base: { text: "one\nTWO\n", hash: "h9" },
		issue: null,
		saving: null,
	});
	const clash = finishSave(saving, { status: "stale", current: file("uno\ntwo\n", "h8") });
	expect(bufferSummary(clash)).toEqual({ status: "conflict", dirty: true, conflicts: 1 });
	expect(beginSave(clash).request).toBeNull();
	const same = finishSave(saving, { status: "stale", current: file("ONE\ntwo\n", "h7") });
	expect(bufferSummary(same)).toEqual({ status: "clean", dirty: false });
	const binary = finishSave(saving, {
		status: "stale",
		current: { content: "", meta: { hash: "h6", byteLength: 4, text: false } },
	});
	expect(bufferSummary(binary)).toEqual({ status: "error", dirty: true, error: "notEditable" });
	expect(binary.text).toBe("ONE\ntwo\n");
});

test("a missing result never re-creates the file: the buffer shows deleted", () => {
	const saving = beginSave(edit(createBuffer(disk("a")), "b")).state;
	expect(bufferSummary(finishSave(saving, { status: "missing" }))).toEqual({
		status: "deleted",
		dirty: true,
	});
});

test("a draft on the same base restores dirty; on another base it restores as a conflict", () => {
	const clean = createBuffer(disk("a"));
	expect(restoreDraft(clean, { text: "draft", baseHash: "h:a" })).toMatchObject({
		text: "draft",
		issue: null,
	});
	const moved = restoreDraft(clean, { text: "draft", baseHash: "h:old" });
	expect(moved.text).toBe("draft");
	expect(bufferStatus(moved)).toBe("stale");
	expect(reloadFromDisk(moved).text).toBe("a");
	const typed = edit(clean, "typed first");
	expect(restoreDraft(typed, { text: "draft", baseHash: "h:a" })).toBe(typed);
});

test("a deleted buffer reports a too-large save instead of 'deleted'", () => {
	const deleted = markMissing(edit(createBuffer(disk("a")), "x".repeat(FILE_WRITE_MAX_BYTES + 1)));
	expect(bufferSummary(beginSave(deleted).state)).toEqual({
		status: "error",
		dirty: true,
		error: "tooLarge",
	});
});

test("a deleted file that comes back with the base text keeps the edits, with no conflict", () => {
	const deleted = markMissing(edit(createBuffer(disk("base")), "mine"));
	const back = adoptDisk(deleted, disk("base", "h2"));
	expect(bufferSummary(back)).toEqual({ status: "dirty", dirty: true });
	expect(back.base).toEqual({ text: "base", hash: "h2" });
	expect(bufferStatus(adoptDisk(deleted, disk("other", "h3")))).toBe("conflict");
});

test("a draft restored as a conflict keeps the hash it was typed on until the user decides", () => {
	const moved = restoreDraft(createBuffer(disk("theirs")), { text: "mine", baseHash: "h:old" });
	expect(draftBaseHash(moved)).toBe("h:old");
	expect(draftBaseHash(edit(moved, "mine!"))).toBe("h:old");
	const newer = adoptDisk(moved, disk("newer"));
	expect(bufferStatus(newer)).toBe("stale");
	expect(draftBaseHash(newer)).toBe("h:old");
	expect(draftBaseHash(keepMine(moved))).toBe("h:theirs");
});

test("this page's own write that landed without a reply is adopted, not shown as a conflict", () => {
	const saving = beginSave(edit(createBuffer(disk("one")), "Aone")).state;
	const lost = failSave(edit(saving, "BAone"), "failed");
	expect(bufferSummary(lost)).toEqual({ status: "error", dirty: true, error: "failed" });
	const echoed = adoptDisk(lost, disk("Aone", "h1"));
	expect(echoed).toMatchObject({ text: "BAone", base: disk("Aone", "h1"), issue: null });
	const retry = beginSave(lost);
	expect(retry.request).toEqual({ content: "BAone", expect: { hash: "h:one" } });
	const stale = finishSave(retry.state, { status: "stale", current: file("Aone", "h1") });
	expect(stale).toMatchObject({ base: disk("Aone", "h1"), issue: null, unconfirmed: null });
	expect(bufferStatus(adoptDisk(stale, disk("other", "h2")))).toBe("conflict");
});

test("a fresh text read clears 'not editable' and 'offline', even on the same hash", () => {
	const dirty = edit(createBuffer(disk("a")), "b");
	expect(adoptDisk(markError(dirty, "notEditable"), disk("a")).issue).toBeNull();
	expect(adoptDisk(markError(dirty, "offline"), disk("a")).issue).toBeNull();
	expect(adoptDisk(markError(dirty, "tooLarge"), disk("a")).issue).toEqual({
		kind: "error",
		error: "tooLarge",
	});
});
