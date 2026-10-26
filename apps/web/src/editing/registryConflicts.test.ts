import { expect, test } from "bun:test";
import { DRAFT_ID, fakeDisk, memoryDrafts, PATH, settle, setup, type } from "./registryFixtures";

type Setup = ReturnType<typeof setup>;

const diskChange = ({ disk, handle }: Pick<Setup, "disk" | "handle">, text: string) => {
	disk.put(PATH, text);
	handle.adoptRead(disk.content(PATH), handle.readToken());
};

const firstConflict = (handle: Setup["handle"]) => {
	const [conflict] = handle.session.conflicts();
	if (!conflict) throw new Error("no open conflict");
	return conflict;
};

test("undo after a newer disk change never brings back an older conflict over the newer one", async () => {
	const context = setup();
	const { disk, registry, handle } = context;
	type(handle, 0, "mine ");
	diskChange(context, "theirs\ntwo\n");
	handle.session.resolveConflict(firstConflict(handle).id, "mine");
	diskChange(context, "theirs2\ntwo\n");
	expect(handle.session.conflicts()).toMatchObject([{ theirs: "theirs2\n" }]);
	handle.session.undo();
	expect(handle.session.conflicts()).toMatchObject([{ theirs: "theirs2\n" }]);
	handle.session.resolveConflict(firstConflict(handle).id, "theirs");
	await registry.save(handle.key);
	expect(disk.text(PATH)).toBe("theirs2\ntwo\n");
});

test("undo after the disk caught up with the buffer does not reopen a resolved conflict", () => {
	const context = setup();
	const { handle } = context;
	type(handle, 0, "mine ");
	diskChange(context, "theirs\ntwo\n");
	handle.session.resolveConflict(firstConflict(handle).id, "both");
	diskChange(context, handle.session.snapshot());
	handle.session.undo();
	expect(handle.session.snapshot()).toBe("mine one\ntwo\n");
	expect(handle.session.conflicts()).toEqual([]);
});

test("undo of Reload restores the text but no conflict from before the reload", () => {
	const lines = Array.from({ length: 3000 }, (_, index) => `line ${index}\n`);
	const context = setup({ text: lines.join("") });
	const { handle, summaries } = context;
	type(handle, 0, "mine ");
	diskChange(context, `theirs\n${lines.slice(1).join("")}`);
	expect(handle.session.conflicts()).toHaveLength(1);
	diskChange(context, lines.map((line, index) => (index % 2 ? line : `agent ${line}`)).join(""));
	expect(summaries.at(-1)?.status).toBe("stale");
	handle.reload();
	expect(handle.session.conflicts()).toEqual([]);
	handle.session.undo();
	expect(handle.session.snapshot().startsWith("mine line 0\n")).toBe(true);
	expect(handle.session.conflicts()).toEqual([]);
});

test("a conflict the disk did not touch again survives, and undo still reopens it", () => {
	const context = setup({ text: "one\ntwo\nthree\nfour\n" });
	const { handle } = context;
	type(handle, 0, "mine ");
	diskChange(context, "theirs\ntwo\nthree\nfour\n");
	const before = firstConflict(handle);
	diskChange(context, "theirs\ntwo\nthree\nFOUR\n");
	expect(handle.session.snapshot()).toBe("mine one\ntwo\nthree\nFOUR\n");
	expect(handle.session.conflicts()).toEqual([before]);
	handle.session.resolveConflict(before.id, "mine");
	handle.session.undo();
	expect(handle.session.conflicts()).toEqual([before]);
});

test("a disk change that settles a conflict's lines closes it", async () => {
	const context = setup({ text: "one\ntwo\nthree\n" });
	const { disk, registry, handle, summaries } = context;
	type(handle, 0, "mine ");
	diskChange(context, "theirs\ntwo\nthree\n");
	type(handle, handle.session.snapshot().length, "four\n");
	diskChange(context, "mine one\ntwo\nthree\n");
	expect(handle.session.conflicts()).toEqual([]);
	expect(summaries.at(-1)).toEqual({ status: "dirty", dirty: true });
	await registry.save(handle.key);
	expect(disk.text(PATH)).toBe("mine one\ntwo\nthree\nfour\n");
});

test("a newer disk version of a conflict's lines replaces its Theirs", () => {
	const context = setup({ text: "one\ntwo\nthree\n" });
	const { handle } = context;
	type(handle, 0, "mine ");
	diskChange(context, "theirs\ntwo\nthree\n");
	type(handle, handle.session.snapshot().length, "four\n");
	diskChange(context, "theirs2\ntwo\nthree\n");
	expect(handle.session.conflicts()).toMatchObject([{ from: 0, to: 9, theirs: "theirs2\n" }]);
});

test("a stale save that merges into a conflict still re-reads a change made during the write", async () => {
	const { disk, registry, handle } = setup({ text: "one\ntwo\nthree\n" });
	type(handle, 0, "mine ");
	disk.put(PATH, "theirs\ntwo\nthree\n");
	const write = disk.io.write;
	disk.io.write = async (params) => {
		const result = await write(params);
		disk.put(PATH, "theirs\ntwo\nTHREE\n");
		handle.adoptRead(disk.content(PATH), handle.readToken());
		return result;
	};
	const summary = await registry.save(handle.key);
	expect(disk.writes).toHaveLength(1);
	expect(handle.session.snapshot()).toBe("mine one\ntwo\nTHREE\n");
	expect(summary).toEqual({ status: "conflict", dirty: true, conflicts: 1 });
});

test("a stale save answer during a composition saves again once it ends", async () => {
	const { disk, registry, handle } = setup();
	type(handle, 0, "x");
	const release = disk.hold();
	const pending = registry.save(handle.key);
	handle.session.setComposing(true);
	disk.put(PATH, "one\nTWO\n");
	release();
	await pending;
	expect(disk.text(PATH)).toBe("one\nTWO\n");
	expect(handle.session.snapshot()).toBe("xone\ntwo\n");
	handle.session.applyLocal([{ from: 1, to: 1, insert: "あ" }], "composeStart");
	handle.session.setComposing(false);
	await settle();
	expect(disk.text(PATH)).toBe("xあone\nTWO\n");
	expect(handle.session.snapshot()).toBe("xあone\nTWO\n");
});

test("open conflicts survive a page reload through the draft", async () => {
	const drafts = memoryDrafts();
	const disk = fakeDisk({ [PATH]: "one\ntwo\n" });
	const first = setup({ disk, drafts });
	type(first.handle, 0, "mine ");
	diskChange(first, "theirs\ntwo\n");
	first.registry.flushDrafts();
	await settle();
	expect(drafts.records.get(DRAFT_ID)?.conflicts).toEqual([
		{ from: 0, to: 9, theirs: "theirs\n", base: "one\n" },
	]);

	const second = setup({ disk, drafts, owner: "page-b" });
	await settle();
	expect(second.handle.session.snapshot()).toBe("mine one\ntwo\n");
	expect(second.summaries.at(-1)).toEqual({ status: "conflict", dirty: true, conflicts: 1 });
	await second.registry.save(second.handle.key);
	expect(disk.writes).toEqual([]);
	second.handle.session.resolveConflict(firstConflict(second.handle).id, "mine");
	await settle();
	expect(drafts.records.get(DRAFT_ID)?.conflicts).toBeUndefined();
});

test("a draft conflict outside the draft text is dropped", async () => {
	const drafts = memoryDrafts({
		[DRAFT_ID]: {
			text: "mine one\ntwo\n",
			baseHash: "rev-1",
			owner: "page-gone",
			conflicts: [{ from: 0, to: 99, theirs: "x\n" }],
		},
	});
	const { handle, summaries } = setup({ drafts });
	await settle();
	expect(handle.session.snapshot()).toBe("mine one\ntwo\n");
	expect(summaries.at(-1)).toEqual({ status: "dirty", dirty: true });
});

test("a cursor move publishes nothing", () => {
	const { handle, summaries } = setup();
	type(handle, 0, "x");
	const published = summaries.length;
	for (let offset = 0; offset < 5; offset += 1) {
		handle.session.select([{ anchor: offset, head: offset }]);
	}
	expect(summaries).toHaveLength(published);
});

test("typing after a conflict keeps the same conflict list", () => {
	const context = setup({ text: "one\ntwo\nthree\n" });
	const { handle } = context;
	type(handle, 0, "mine ");
	diskChange(context, "theirs\ntwo\nthree\n");
	const conflicts = handle.session.conflicts();
	type(handle, handle.session.snapshot().length, "end");
	expect(handle.session.conflicts()).toBe(conflicts);
	type(handle, 0, ">");
	expect(handle.session.conflicts()).not.toBe(conflicts);
	expect(handle.session.conflicts()).toMatchObject([{ from: 0, to: 10 }]);
});

test("typing at the end of a conflict on a last line without a newline stays inside it", () => {
	const context = setup({ text: "one\ntwo" });
	const { handle } = context;
	type(handle, 7, "X");
	diskChange(context, "one\ntwoY");
	type(handle, handle.session.snapshot().length, "Z");
	expect(handle.session.snapshot()).toBe("one\ntwoXZ");
	handle.session.resolveConflict(firstConflict(handle).id, "theirs");
	expect(handle.session.snapshot()).toBe("one\ntwoY");
});

test("a remote append after a last-line conflict stays outside it", () => {
	const context = setup({ text: "one\ntwo" });
	const { handle } = context;
	type(handle, 7, "X");
	diskChange(context, "one\ntwoY");
	diskChange(context, "one\ntwoY\nthree");
	expect(handle.session.snapshot()).toBe("one\ntwoX\nthree");
	handle.session.resolveConflict(firstConflict(handle).id, "theirs");
	expect(handle.session.snapshot()).toBe("one\ntwoY\nthree");
});

test("Theirs and Both for a deleted last line keep its line break", () => {
	for (const [choice, expected] of [
		["theirs", "a\nb2"],
		["both", "a\nb2"],
		["mine", "a"],
	] as const) {
		const context = setup({ text: "a\nb\n" });
		const { handle } = context;
		handle.session.applyLocal([{ from: 2, to: 4, insert: "" }], "delete");
		diskChange(context, "a\nb2");
		handle.session.resolveConflict(firstConflict(handle).id, choice);
		expect(handle.session.snapshot()).toBe(expected);
	}
});

test("Both on two functions inserted at the same point keeps each whole", () => {
	const context = setup({ text: "a\n" });
	const { handle } = context;
	type(handle, 2, "function x() {\n}\n");
	diskChange(context, "a\nfunction y() {\n}\n");
	handle.session.resolveConflict(firstConflict(handle).id, "both");
	expect(handle.session.snapshot()).toBe("a\nfunction x() {\n}\nfunction y() {\n}\n");
});

test("undo of a Theirs pick reopens the conflict after a disk change on other lines", async () => {
	const context = setup({ text: "one\ntwo\nthree\n" });
	const { disk, registry, handle } = context;
	type(handle, 0, "mine ");
	diskChange(context, "theirs\ntwo\nthree\n");
	handle.session.resolveConflict(firstConflict(handle).id, "theirs");
	diskChange(context, "theirs\ntwo\nTHREE\n");
	handle.session.undo();
	expect(handle.session.snapshot()).toBe("mine one\ntwo\nTHREE\n");
	expect(handle.session.conflicts()).toMatchObject([{ theirs: "theirs\n" }]);
	expect(context.summaries.at(-1)).toMatchObject({ status: "conflict" });
	await registry.save(handle.key);
	expect(disk.writes).toEqual([]);
});

test("an undo that takes the disk side reaches the view as one change set", () => {
	const context = setup({ text: "a\nb\nc\n" });
	const { handle } = context;
	type(handle, 3, "X");
	diskChange(context, "a\nbY\nc\n");
	let mirrored = handle.session.snapshot();
	handle.session.subscribe((update) => {
		for (const change of [...update.changes].reverse()) {
			mirrored = mirrored.slice(0, change.from) + change.insert + mirrored.slice(change.to);
		}
	});
	handle.session.undo();
	expect(handle.session.snapshot()).toBe("a\nbY\nc\n");
	expect(mirrored).toBe("a\nbY\nc\n");
	expect(handle.session.conflicts()).toEqual([]);
});

test("a conflict choice sends no selection, and the next undo restores the real cursor", () => {
	const context = setup({ text: "one\ntwo\nthree\nfour\n" });
	const { handle } = context;
	const selections: unknown[] = [];
	handle.session.subscribe((update) => selections.push(update.selection));
	type(handle, 0, "mine ");
	diskChange(context, "theirs\ntwo\nthree\nfour\n");
	const end = handle.session.snapshot().length;
	handle.session.select([{ anchor: end, head: end }]);
	handle.session.resolveConflict(firstConflict(handle).id, "theirs");
	expect(selections.at(-1)).toBeUndefined();
	const cursor = handle.session.snapshot().length;
	type(handle, cursor, "X");
	handle.session.select([{ anchor: cursor + 1, head: cursor + 1 }]);
	handle.session.undo();
	expect(selections.at(-1)).toEqual([{ anchor: cursor, head: cursor }]);
});
