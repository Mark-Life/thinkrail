import { expect, test } from "bun:test";
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
