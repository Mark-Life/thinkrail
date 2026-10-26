import { expect, test } from "bun:test";
import { RequestError } from "../transport";
import {
	DRAFT_ID,
	fakeDisk,
	live,
	memoryDrafts,
	notFound,
	PATH,
	settle,
	setup,
	type,
	WS,
} from "./registryFixtures";

test("typing marks the buffer dirty and a save writes it against the base hash", async () => {
	const { disk, registry, handle, summaries } = setup();
	type(handle, 0, "// ");
	expect(summaries.at(-1)).toEqual({ status: "dirty", dirty: true });
	const summary = await registry.save(handle.key);
	expect(disk.writes).toEqual([
		{ workspaceId: WS, path: PATH, content: "// one\ntwo\n", expect: { hash: "rev-1" } },
	]);
	expect(disk.text(PATH)).toBe("// one\ntwo\n");
	expect(summary).toEqual({ status: "clean", dirty: false });
});

test("a clean buffer follows the disk as deltas to the attached editor", () => {
	const { disk, handle, received } = setup();
	disk.put(PATH, "one\nTWO\n");
	handle.adoptRead(disk.content(PATH), handle.readToken());
	expect(handle.session.snapshot()).toBe("one\nTWO\n");
	expect(received).toEqual([[{ from: 4, to: 7, insert: "TWO" }]]);
});

test("the editor's own edits are never echoed back to it", () => {
	const { handle, received } = setup();
	type(handle, 0, "x");
	expect(received).toEqual([]);
});

test("a dirty buffer merges a disk change on another line, and a save writes both", async () => {
	const { disk, registry, handle, received, summaries } = setup();
	type(handle, 0, "mine ");
	disk.put(PATH, "one\nTWO\n");
	handle.adoptRead(disk.content(PATH), handle.readToken());
	expect(handle.session.snapshot()).toBe("mine one\nTWO\n");
	expect(received.at(-1)).toEqual([{ from: 9, to: 12, insert: "TWO" }]);
	expect(summaries.at(-1)).toEqual({ status: "dirty", dirty: true });
	await registry.save(handle.key);
	expect(disk.text(PATH)).toBe("mine one\nTWO\n");
});

test("a change to the same line pauses the save until the user picks a side", async () => {
	const { disk, registry, handle, summaries } = setup();
	type(handle, 0, "mine ");
	disk.put(PATH, "theirs\ntwo\n");
	handle.adoptRead(disk.content(PATH), handle.readToken());
	expect(handle.session.snapshot()).toBe("mine one\ntwo\n");
	expect(summaries.at(-1)).toEqual({ status: "conflict", dirty: true, conflicts: 1 });
	expect(handle.session.conflicts()).toEqual([
		{ id: expect.any(Number), from: 0, to: 9, theirs: "theirs\n" },
	]);
	await registry.save(handle.key);
	expect(disk.writes).toEqual([]);
	const [conflict] = handle.session.conflicts();
	handle.session.resolveConflict(conflict?.id ?? 0, "both");
	expect(handle.session.snapshot()).toBe("mine one\ntheirs\ntwo\n");
	expect(handle.session.conflicts()).toEqual([]);
	handle.session.undo();
	expect(handle.session.snapshot()).toBe("mine one\ntwo\n");
	expect(handle.session.conflicts()).toHaveLength(1);
	handle.session.resolveConflict(handle.session.conflicts()[0]?.id ?? 0, "theirs");
	await registry.save(handle.key);
	expect(disk.text(PATH)).toBe("theirs\ntwo\n");
});

test("Mine keeps the text, saves it, and undo reopens the conflict", async () => {
	const { disk, registry, handle, received } = setup();
	type(handle, 0, "mine ");
	disk.put(PATH, "theirs\ntwo\n");
	handle.adoptRead(disk.content(PATH), handle.readToken());
	const updates = received.length;
	handle.session.resolveConflict(handle.session.conflicts()[0]?.id ?? 0, "mine");
	expect(handle.session.conflicts()).toEqual([]);
	expect(received.slice(updates)).toEqual([[]]);
	handle.session.undo();
	expect(handle.session.conflicts()).toHaveLength(1);
	expect(handle.session.snapshot()).toBe("mine one\ntwo\n");
	handle.session.redo();
	expect(handle.session.conflicts()).toEqual([]);
	await registry.save(handle.key);
	expect(disk.text(PATH)).toBe("mine one\ntwo\n");
});

test("Keep mine and Reload stay for a disk change that cannot merge", async () => {
	const { disk, registry, handle, summaries } = setup();
	const lines = Array.from({ length: 3000 }, (_, index) => `line ${index}\n`);
	disk.put(PATH, lines.join(""));
	handle.adoptRead(disk.content(PATH), handle.readToken());
	type(handle, 0, "mine ");
	disk.put(PATH, lines.map((line, index) => (index % 2 ? line : `agent ${line}`)).join(""));
	handle.adoptRead(disk.content(PATH), handle.readToken());
	expect(summaries.at(-1)?.status).toBe("stale");
	handle.keepMine();
	await registry.save(handle.key);
	expect(disk.text(PATH)?.startsWith("mine line 0\n")).toBe(true);
	type(handle, 0, "x");
	const agent = lines.map((line, index) => (index % 2 ? `agent ${line}` : line)).join("");
	disk.put(PATH, agent);
	handle.adoptRead(disk.content(PATH), handle.readToken());
	expect(summaries.at(-1)?.status).toBe("stale");
	handle.reload();
	expect(handle.session.snapshot()).toBe(agent);
	expect(summaries.at(-1)).toEqual({ status: "clean", dirty: false });
});

test("a stale save merges the disk version and retries once", async () => {
	const { disk, registry, handle } = setup();
	type(handle, 0, "mine ");
	disk.put(PATH, "one\nagent\n");
	const summary = await registry.save(handle.key);
	expect(disk.writes.map((write) => write.content)).toEqual([
		"mine one\ntwo\n",
		"mine one\nagent\n",
	]);
	expect(disk.text(PATH)).toBe("mine one\nagent\n");
	expect(summary).toEqual({ status: "clean", dirty: false });
});

test("a stale save on the same line pauses and writes nothing", async () => {
	const { disk, registry, handle } = setup();
	type(handle, 0, "mine ");
	disk.put(PATH, "agent wrote this\n");
	const summary = await registry.save(handle.key);
	expect(summary).toMatchObject({ status: "conflict", conflicts: 1 });
	expect(disk.text(PATH)).toBe("agent wrote this\n");
});

test("undo skips a merge above the cursor, and redo brings the edit back", () => {
	const { disk, handle } = setup();
	type(handle, 4, "X");
	disk.put(PATH, "zero\none\ntwo\n");
	handle.adoptRead(disk.content(PATH), handle.readToken());
	expect(handle.session.snapshot()).toBe("zero\none\nXtwo\n");
	handle.session.undo();
	expect(handle.session.snapshot()).toBe("zero\none\ntwo\n");
	expect(handle.session.canUndo()).toBe(false);
	handle.session.redo();
	expect(handle.session.snapshot()).toBe("zero\none\nXtwo\n");
});

test("only merges in the history means nothing to undo", () => {
	const { disk, handle, received } = setup();
	disk.put(PATH, "one\nTWO\n");
	handle.adoptRead(disk.content(PATH), handle.readToken());
	expect(handle.session.canUndo()).toBe(false);
	handle.session.undo();
	expect(handle.session.snapshot()).toBe("one\nTWO\n");
	expect(received).toHaveLength(1);
});

test("undo sends the change and the restored selection to the editor", () => {
	const { handle } = setup();
	const updates: unknown[] = [];
	handle.session.subscribe((update) => updates.push(update));
	handle.session.select([{ anchor: 4, head: 4 }]);
	type(handle, 4, "X");
	handle.session.undo();
	expect(updates).toEqual([
		{ changes: [{ from: 4, to: 5, insert: "" }], selection: [{ anchor: 4, head: 4 }] },
	]);
});

test("a disk read waits while the editor is composing, then merges", async () => {
	const { disk, handle } = setup();
	type(handle, 0, "mine ");
	handle.session.setComposing(true);
	disk.put(PATH, "one\nTWO\n");
	handle.adoptRead(disk.content(PATH), handle.readToken());
	expect(handle.session.snapshot()).toBe("mine one\ntwo\n");
	handle.session.setComposing(false);
	await settle();
	expect(handle.session.snapshot()).toBe("mine one\nTWO\n");
});

test("a read that lands during a save is dropped, and one fresh read follows the save", async () => {
	const { disk, registry, handle, received } = setup();
	type(handle, 0, "a");
	const release = disk.hold();
	const saving = registry.save(handle.key);
	const before = disk.content(PATH);
	handle.adoptRead(before, handle.readToken());
	release();
	await saving;
	await settle();
	expect(handle.session.snapshot()).toBe("aone\ntwo\n");
	expect(received).toEqual([]);
});

test("a read that started before a save and lands after it is re-read, not adopted", async () => {
	const { disk, registry, handle } = setup();
	type(handle, 0, "a");
	const token = handle.readToken();
	const stale = disk.content(PATH);
	await registry.save(handle.key);
	handle.adoptRead(stale, token);
	await settle();
	expect(handle.session.snapshot()).toBe("aone\ntwo\n");
});

test("a failed read of a deleted file marks it deleted, and Save creates it again", async () => {
	const { disk, registry, handle, summaries } = setup();
	disk.remove(PATH);
	handle.readFailed(notFound(), handle.readToken());
	await settle();
	expect(summaries.at(-1)).toEqual({ status: "deleted", dirty: false });
	await registry.save(handle.key);
	expect(disk.writes.at(-1)?.expect).toEqual({ hash: null });
	expect(disk.text(PATH)).toBe("one\ntwo\n");
});

test("a save that finds the file gone reports deleted instead of re-creating it", async () => {
	const { disk, registry, handle } = setup();
	type(handle, 0, "x");
	disk.remove(PATH);
	const summary = await registry.save(handle.key);
	expect(summary).toEqual({ status: "deleted", dirty: true });
	expect(disk.text(PATH)).toBeUndefined();
});

test("a draft is written after a pause and removed once the buffer is clean", async () => {
	const { drafts, registry, handle } = setup();
	type(handle, 0, "x");
	expect(drafts.records.size).toBe(0);
	await settle();
	expect([...drafts.records.values()]).toEqual([
		{ text: "xone\ntwo\n", baseHash: "rev-1", owner: "page-a" },
	]);
	await registry.save(handle.key);
	await settle();
	expect(drafts.records.size).toBe(0);
});

test("a buffer created again restores its draft and says so", async () => {
	const key = DRAFT_ID;
	const drafts = memoryDrafts({ [key]: { text: "draft\n", baseHash: "rev-1", owner: "page-a" } });
	const { handle, restored, summaries, received } = setup({ drafts });
	await settle();
	expect(handle.session.snapshot()).toBe("draft\n");
	expect(restored).toEqual([PATH]);
	expect(summaries.at(-1)).toEqual({ status: "dirty", dirty: true });
	expect(received).toHaveLength(1);
});

test("closing the tab drops the buffer but keeps its draft; Don't save drops both", async () => {
	const { drafts, registry, handle, summaries } = setup();
	type(handle, 0, "x");
	registry.prune(new Set());
	expect(registry.get(handle.key)).toBeNull();
	expect(summaries.at(-1)).toBeNull();
	await settle();
	expect(drafts.records.size).toBe(1);

	const second = setup({ drafts, owner: "page-b" });
	await settle();
	second.registry.discard(second.handle.key);
	await settle();
	expect(drafts.records.size).toBe(0);
});

test("a reconnect re-reads every buffer once", async () => {
	const { disk, registry, handle } = setup();
	disk.put(PATH, "changed while offline\n");
	await registry.reconcileAll();
	expect(handle.session.snapshot()).toBe("changed while offline\n");
});

const draftKeyId = DRAFT_ID;

test("a draft equal to the buffer text is deleted, so it never comes back as a fake conflict", async () => {
	const drafts = memoryDrafts({
		[draftKeyId]: { text: "saved\n", baseHash: "rev-0", owner: "page-old" },
	});
	const disk = fakeDisk({ [PATH]: "saved\n" });
	const first = setup({ disk, drafts, owner: "page-b" });
	await settle();
	expect(first.restored).toEqual([]);
	expect(drafts.records.size).toBe(0);

	first.registry.discard(first.handle.key);
	disk.put(PATH, "agent\n");
	const second = setup({ disk, drafts, owner: "page-c" });
	await settle();
	expect(second.restored).toEqual([]);
	expect(second.summaries.at(-1)).toEqual({ status: "clean", dirty: false });
});

test("a buffer dropped while its save is in flight leaves no draft that resurrects", async () => {
	const disk = fakeDisk({ [PATH]: "one\n" });
	const drafts = memoryDrafts();
	const first = setup({ disk, drafts, owner: "page-a" });
	type(first.handle, 0, "saved ");
	const release = disk.hold();
	const saving = first.registry.save(first.handle.key);
	first.registry.prune(new Set());
	release();
	await saving;
	expect(drafts.records.size).toBe(1);

	const second = setup({ disk, drafts, owner: "page-b" });
	await settle();
	expect(drafts.records.size).toBe(0);
	second.registry.discard(second.handle.key);
	disk.put(PATH, "agent\n");
	const third = setup({ disk, drafts, owner: "page-c" });
	await settle();
	expect(third.restored).toEqual([]);
	expect(third.handle.session.snapshot()).toBe("agent\n");
});

test("a failed re-create of a deleted file shows why instead of 'deleted'", async () => {
	const { disk, registry, handle } = setup();
	disk.remove(PATH);
	handle.readFailed(notFound(), handle.readToken());
	await settle();
	type(handle, 0, "x");
	const write = disk.io.write;
	disk.io.write = async () => ({ status: "readonly" });
	expect(await registry.save(handle.key)).toEqual({ status: "readonly", dirty: true });
	disk.io.write = async () => {
		throw new Error("socket closed");
	};
	expect(await registry.save(handle.key)).toEqual({
		status: "error",
		dirty: true,
		error: "failed",
	});
	disk.io.write = write;
});

test("a NOT_EDITABLE save says so instead of asking for a retry", async () => {
	const { disk, registry, handle } = setup();
	type(handle, 0, "x");
	disk.io.write = async () => {
		throw new RequestError("NOT_EDITABLE", "src/a.ts is not a regular file");
	};
	expect(await registry.save(handle.key)).toEqual({
		status: "error",
		dirty: true,
		error: "notEditable",
	});
});

test("a read that fails for another reason leaves the buffer alone instead of marking it deleted", async () => {
	const { disk, handle, summaries, registry } = setup();
	type(handle, 0, "// ");
	handle.readFailed(new Error("Request timed out"), handle.readToken());
	await settle();
	expect(summaries.at(-1)).toEqual({ status: "dirty", dirty: true });
	disk.io.read = () => Promise.reject(new Error("Request timed out"));
	await registry.reconcileAll();
	expect(summaries.at(-1)).toEqual({ status: "dirty", dirty: true });
});

test("a not-found read during a re-creating save waits for one fresh read after it", async () => {
	const { disk, registry, handle, summaries } = setup();
	disk.remove(PATH);
	handle.readFailed(notFound(), handle.readToken());
	await settle();
	expect(summaries.at(-1)).toEqual({ status: "deleted", dirty: false });
	const release = disk.hold();
	const saving = registry.save(handle.key);
	handle.readFailed(notFound(), handle.readToken());
	release();
	expect(await saving).toEqual({ status: "clean", dirty: false });
	await settle();
	expect(summaries.at(-1)).toEqual({ status: "clean", dirty: false });
});

test("a second window neither restores nor deletes the draft of a window still open", async () => {
	const disk = fakeDisk({ [PATH]: "one\ntwo\n" });
	const drafts = memoryDrafts();
	live.add("page-a");
	try {
		const a = setup({ disk, drafts, owner: "page-a" });
		type(a.handle, 0, "A ");
		await settle();
		const b = setup({ disk, drafts, owner: "page-b" });
		await settle();
		expect(b.restored).toEqual([]);
		expect(b.handle.session.snapshot()).toBe("one\ntwo\n");
		b.registry.discard(b.handle.key);
		await settle();
		expect([...drafts.records.values()]).toEqual([
			{ text: "A one\ntwo\n", baseHash: "rev-1", owner: "page-a" },
		]);
	} finally {
		live.delete("page-a");
	}
	const c = setup({ disk, drafts, owner: "page-c" });
	await settle();
	expect(c.restored).toEqual([PATH]);
	expect([...drafts.records.values()].map((draft) => draft.owner)).toEqual(["page-c"]);
});
