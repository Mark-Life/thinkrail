import { expect, test } from "bun:test";
import type { FileContent } from "@thinkrail/contracts";
import {
	DRAFT_ID,
	draftRecordId,
	fakeDisk,
	memoryDrafts,
	PATH,
	settle,
	setup,
	type,
} from "./registryFixtures";

test("a draft restored as a conflict stays a conflict after another reload", async () => {
	const drafts = memoryDrafts({
		[DRAFT_ID]: { text: "my edit on v1\n", baseHash: "old-v1", owner: "dead-page" },
	});
	const disk = fakeDisk({ [PATH]: "agent v2\n" });
	const first = setup({ disk, drafts, owner: "page-1" });
	await settle();
	expect(first.summaries.at(-1)).toEqual({ status: "stale", dirty: true });
	expect(drafts.records.get(DRAFT_ID)).toEqual({
		text: "my edit on v1\n",
		baseHash: "old-v1",
		owner: "page-1",
	});
	type(first.handle, 0, "!");
	await settle();
	expect(drafts.records.get(DRAFT_ID)?.baseHash).toBe("old-v1");

	const second = setup({ disk, drafts, owner: "page-2" });
	await settle();
	expect(second.summaries.at(-1)).toEqual({ status: "stale", dirty: true });
	await second.registry.save(second.handle.key);
	expect(disk.writes).toEqual([]);
	expect(disk.text(PATH)).toBe("agent v2\n");
});

test("a save asked for during a write runs after it, so later typing reaches disk", async () => {
	const { disk, registry, handle } = setup({ text: "one\n" });
	const release = disk.hold();
	type(handle, 0, "A");
	const first = registry.save(handle.key);
	type(handle, 0, "B");
	const second = registry.save(handle.key);
	const third = registry.save(handle.key);
	release();
	expect(await first).toEqual({ status: "dirty", dirty: true });
	expect(await second).toEqual({ status: "clean", dirty: false });
	expect(await third).toEqual({ status: "clean", dirty: false });
	expect(disk.writes.map((write) => write.content)).toEqual(["Aone\n", "BAone\n"]);
	expect(disk.text(PATH)).toBe("BAone\n");
});

test("a write that landed but lost its reply is adopted on reconnect, not shown as a conflict", async () => {
	const { disk, registry, handle, summaries } = setup({ text: "one\n" });
	const write = disk.io.write;
	disk.io.write = async (params) => {
		await write(params);
		throw new Error("request timed out");
	};
	type(handle, 0, "A");
	const saving = registry.save(handle.key);
	type(handle, 0, "B");
	expect(await saving).toEqual({ status: "error", dirty: true, error: "failed" });
	disk.io.write = write;
	await registry.reconcileAll();
	expect(summaries.at(-1)).toEqual({ status: "dirty", dirty: true });
	expect(await registry.save(handle.key)).toEqual({ status: "clean", dirty: false });
	expect(disk.text(PATH)).toBe("BAone\n");
});

test("a retry after a lost reply writes the newer text instead of raising a conflict", async () => {
	const { disk, registry, handle } = setup({ text: "one\n" });
	const write = disk.io.write;
	disk.io.write = async (params) => {
		await write(params);
		throw new Error("request timed out");
	};
	type(handle, 0, "A");
	const saving = registry.save(handle.key);
	type(handle, 0, "B");
	await saving;
	disk.io.write = write;
	expect(await registry.save(handle.key)).toEqual({ status: "clean", dirty: false });
	expect(disk.writes.map((entry) => entry.expect.hash)).toEqual(["rev-1", "rev-1", "rev-2"]);
	expect(disk.text(PATH)).toBe("BAone\n");
});

test("a save while disconnected fails at once with 'offline' and sends nothing", async () => {
	let connected = false;
	const { disk, registry, handle } = setup({ connected: () => connected });
	type(handle, 0, "x");
	expect(await registry.save(handle.key)).toEqual({
		status: "error",
		dirty: true,
		error: "offline",
	});
	expect(disk.writes).toEqual([]);
	connected = true;
	await registry.reconcileAll();
	expect(await registry.save(handle.key)).toEqual({ status: "clean", dirty: false });
});

test("removing a workspace drops its buffers and every draft it left", async () => {
	const otherFile = draftRecordId({ host: "http://host", workspaceId: "ws-1", path: "b.ts" });
	const otherWorkspace = draftRecordId({ host: "http://host", workspaceId: "ws-2", path: PATH });
	const drafts = memoryDrafts({
		[otherFile]: { text: "b", baseHash: "h", owner: "page-old" },
		[otherWorkspace]: { text: "c", baseHash: "h", owner: "page-old" },
	});
	const { registry, handle, summaries } = setup({ drafts });
	type(handle, 0, "x");
	await settle();
	expect(drafts.records.has(DRAFT_ID)).toBe(true);
	registry.forgetWorkspace("ws-1");
	await settle();
	expect([...drafts.records.keys()]).toEqual([otherWorkspace]);
	expect(registry.get(handle.key)).toBeNull();
	expect(summaries.at(-1)).toBeNull();
});

function deferReads(disk: ReturnType<typeof fakeDisk>) {
	const pending: (() => void)[] = [];
	disk.io.read = (_workspaceId, path) => {
		const result = Promise.withResolvers<FileContent>();
		try {
			const file = disk.content(path);
			pending.push(() => result.resolve(file));
		} catch (error) {
			pending.push(() => result.reject(error));
		}
		return result.promise;
	};
	return { land: (index: number) => pending[index]?.() };
}

test("an older read that lands after a newer one never brings back older disk text", async () => {
	const { disk, registry, handle } = setup({ text: "one\n" });
	const reads = deferReads(disk);
	disk.put(PATH, "two\n");
	const older = registry.reconcileAll();
	disk.put(PATH, "three\n");
	const newer = registry.reconcileAll();
	reads.land(1);
	await newer;
	expect(handle.session.snapshot()).toBe("three\n");
	reads.land(0);
	await older;
	expect(handle.session.snapshot()).toBe("three\n");
});

test("a tab read that started first and lands last keeps the newer text and base", async () => {
	const { disk, registry, handle } = setup({ text: "one\n" });
	const reads = deferReads(disk);
	disk.put(PATH, "two\n");
	const tabToken = handle.readToken();
	const tabRead = disk.content(PATH);
	disk.put(PATH, "three\n");
	const newer = registry.reconcileAll();
	reads.land(0);
	await newer;
	handle.adoptRead(tabRead, tabToken);
	await settle();
	expect(handle.session.snapshot()).toBe("three\n");
	type(handle, 0, "x");
	expect(await registry.save(handle.key)).toEqual({ status: "clean", dirty: false });
	expect(disk.writes.map((write) => write.expect.hash)).toEqual(["rev-3"]);
});

test("an older read that lands after a newer one leaves a dirty buffer on the newer disk", async () => {
	const { disk, registry, handle, received } = setup();
	const reads = deferReads(disk);
	type(handle, 4, "mine ");
	disk.put(PATH, "ONE\ntwo\n");
	const older = registry.reconcileAll();
	disk.put(PATH, "ONE!\ntwo\n");
	const newer = registry.reconcileAll();
	reads.land(1);
	await newer;
	const text = handle.session.snapshot();
	const updates = received.length;
	reads.land(0);
	await older;
	await settle();
	expect(handle.session.snapshot()).toBe(text);
	expect(received.length).toBe(updates);
	handle.keepMine();
	await registry.save(handle.key);
	expect(disk.writes.map((write) => write.expect.hash)).toEqual(["rev-3"]);
	expect(disk.text(PATH)).toBe(text);
});

test("an older 'not found' that lands after a newer read does not mark the file deleted", async () => {
	const { disk, registry, handle, summaries } = setup({ text: "one\n" });
	const reads = deferReads(disk);
	disk.remove(PATH);
	const older = registry.reconcileAll();
	disk.put(PATH, "back\n");
	const newer = registry.reconcileAll();
	reads.land(1);
	await newer;
	reads.land(0);
	await older;
	expect(handle.session.snapshot()).toBe("back\n");
	expect(summaries.at(-1)).toEqual({ status: "clean", dirty: false });
});
