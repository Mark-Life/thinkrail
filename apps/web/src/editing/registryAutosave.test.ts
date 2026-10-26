import { expect, test } from "bun:test";
import type { FileSaveMode } from "@thinkrail/contracts";
import {
	AUTOSAVE_MS,
	DRAFT_ID,
	memoryDrafts,
	notFound,
	PATH,
	settle,
	setup,
	type,
} from "./registryFixtures";

function autoSetup(options: Parameters<typeof setup>[0] = {}) {
	let mode: FileSaveMode = "auto";
	const context = setup({ ...options, mode: () => mode });
	return {
		...context,
		setMode(next: FileSaveMode) {
			mode = next;
			context.registry.saveModeChanged();
		},
	};
}

test("typing autosaves after the last edit with no explicit save", async () => {
	const { disk, handle, clock, summaries } = autoSetup();
	type(handle, 0, "a");
	expect(summaries.at(-1)).toEqual({ status: "dirty", dirty: true, pending: true });
	clock.advance(AUTOSAVE_MS - 100);
	type(handle, 1, "b");
	clock.advance(AUTOSAVE_MS - 100);
	expect(disk.writes).toHaveLength(0);
	clock.advance(100);
	await settle();
	expect(disk.writes.map((write) => write.content)).toEqual(["abone\ntwo\n"]);
	expect(summaries.at(-1)).toEqual({ status: "clean", dirty: false });
});

test("manual mode never arms a timer", async () => {
	const { disk, handle, clock, summaries } = setup();
	type(handle, 0, "a");
	clock.advance(AUTOSAVE_MS * 5);
	await settle();
	expect(disk.writes).toHaveLength(0);
	expect(clock.timers()).toBe(0);
	expect(summaries.at(-1)).toEqual({ status: "dirty", dirty: true });
});

test("flush writes at once, and Cmd/Ctrl+S cancels the timer", async () => {
	const { disk, registry, handle, clock } = autoSetup();
	type(handle, 0, "a");
	registry.flushAll();
	await settle();
	expect(disk.writes).toHaveLength(1);
	type(handle, 0, "b");
	await registry.save(handle.key);
	expect(disk.writes).toHaveLength(2);
	expect(clock.timers()).toBe(0);
	clock.advance(AUTOSAVE_MS);
	registry.flush(handle.key);
	await settle();
	expect(disk.writes).toHaveLength(2);
});

test("the echo of our own save and a disk change never arm the timer", async () => {
	const { disk, handle, clock } = autoSetup();
	type(handle, 0, "a");
	clock.advance(AUTOSAVE_MS);
	await settle();
	handle.adoptRead(disk.content(PATH), handle.readToken());
	expect(clock.timers()).toBe(0);
	disk.put(PATH, "aone\nTWO\n");
	handle.adoptRead(disk.content(PATH), handle.readToken());
	expect(handle.session.snapshot()).toBe("aone\nTWO\n");
	expect(clock.timers()).toBe(0);
	clock.advance(AUTOSAVE_MS);
	await settle();
	expect(disk.writes).toHaveLength(1);
});

test("a merge does not restart the timer a user edit armed", async () => {
	const { disk, handle, clock } = autoSetup();
	type(handle, 0, "a");
	clock.advance(AUTOSAVE_MS / 2);
	disk.put(PATH, "one\nTWO\n");
	handle.adoptRead(disk.content(PATH), handle.readToken());
	clock.advance(AUTOSAVE_MS / 2);
	await settle();
	expect(disk.writes.map((write) => write.content)).toEqual(["aone\nTWO\n"]);
});

test("a same-line conflict pauses autosave and resolving it resumes", async () => {
	const { disk, handle, clock, summaries } = autoSetup();
	type(handle, 0, "mine ");
	disk.put(PATH, "theirs\ntwo\n");
	handle.adoptRead(disk.content(PATH), handle.readToken());
	type(handle, 0, "x");
	clock.advance(AUTOSAVE_MS);
	await settle();
	expect(disk.writes).toHaveLength(0);
	expect(summaries.at(-1)).toMatchObject({ status: "conflict", dirty: true });
	expect(summaries.at(-1)?.pending).toBeUndefined();
	handle.session.resolveConflict(handle.session.conflicts()[0]?.id ?? 0, "mine");
	expect(summaries.at(-1)?.pending).toBe(true);
	clock.advance(AUTOSAVE_MS);
	await settle();
	expect(disk.text(PATH)).toBe("xmine one\ntwo\n");
});

test("after a thrown save error the file waits for the next edit", async () => {
	const { disk, handle, clock, summaries } = autoSetup();
	const write = disk.io.write;
	let calls = 0;
	disk.io.write = async () => {
		calls += 1;
		throw new Error("socket closed");
	};
	type(handle, 0, "a");
	clock.advance(AUTOSAVE_MS);
	await settle();
	clock.advance(AUTOSAVE_MS * 10);
	await settle();
	expect(calls).toBe(1);
	expect(summaries.at(-1)).toEqual({ status: "error", dirty: true, error: "failed" });
	disk.io.write = write;
	type(handle, 1, "b");
	clock.advance(AUTOSAVE_MS);
	await settle();
	expect(disk.text(PATH)).toBe("abone\ntwo\n");
});

test("a deleted file is never re-created by autosave, only by an explicit save", async () => {
	const { disk, registry, handle, clock } = autoSetup();
	disk.remove(PATH);
	handle.readFailed(notFound());
	type(handle, 0, "a");
	clock.advance(AUTOSAVE_MS);
	await settle();
	expect(disk.writes).toHaveLength(0);
	await registry.save(handle.key);
	expect(disk.text(PATH)).toBe("aone\ntwo\n");
});

test("an IME composition defers the write until it ends", async () => {
	const { disk, handle, clock } = autoSetup();
	handle.session.setComposing?.(true);
	type(handle, 0, "か");
	clock.advance(AUTOSAVE_MS * 3);
	await settle();
	expect(disk.writes).toHaveLength(0);
	handle.session.setComposing?.(false);
	clock.advance(AUTOSAVE_MS);
	await settle();
	expect(disk.text(PATH)).toBe("かone\ntwo\n");
});

test("a save that failed offline autosaves once the reconnect read clears it", async () => {
	let connected = false;
	const { disk, registry, handle, clock, summaries } = autoSetup({ connected: () => connected });
	type(handle, 0, "a");
	clock.advance(AUTOSAVE_MS);
	await settle();
	expect(summaries.at(-1)).toMatchObject({ status: "error", error: "offline" });
	connected = true;
	await registry.reconcileAll();
	clock.advance(AUTOSAVE_MS);
	await settle();
	expect(disk.text(PATH)).toBe("aone\ntwo\n");
});

test("switching to manual cancels timers; switching to auto arms every savable dirty buffer", async () => {
	const { disk, handle, clock, summaries, setMode } = autoSetup();
	type(handle, 0, "a");
	setMode("manual");
	expect(summaries.at(-1)).toEqual({ status: "dirty", dirty: true });
	clock.advance(AUTOSAVE_MS * 2);
	await settle();
	expect(disk.writes).toHaveLength(0);
	setMode("auto");
	expect(summaries.at(-1)).toEqual({ status: "dirty", dirty: true, pending: true });
	clock.advance(AUTOSAVE_MS);
	await settle();
	expect(disk.text(PATH)).toBe("aone\ntwo\n");
});

test("closing a tab with an armed timer writes the edit before the buffer drops", async () => {
	const { disk, registry, handle } = autoSetup();
	type(handle, 0, "a");
	registry.prune(new Set());
	await settle();
	expect(disk.text(PATH)).toBe("aone\ntwo\n");
	expect(registry.get(handle.key)).toBeNull();
});

test("a draft restored on the same base autosaves; one typed on another version waits", async () => {
	const same = autoSetup({
		drafts: memoryDrafts({ [DRAFT_ID]: { text: "draft\n", baseHash: "rev-1", owner: "page-x" } }),
	});
	await settle();
	same.clock.advance(AUTOSAVE_MS);
	await settle();
	expect(same.disk.text(PATH)).toBe("draft\n");

	const other = autoSetup({
		drafts: memoryDrafts({ [DRAFT_ID]: { text: "draft\n", baseHash: "rev-0", owner: "page-x" } }),
	});
	await settle();
	other.clock.advance(AUTOSAVE_MS);
	await settle();
	expect(other.disk.writes).toHaveLength(0);
	expect(other.summaries.at(-1)).toMatchObject({ status: "stale", dirty: true });
});

test("an edit made after reopening a closing tab is written when the tab closes again", async () => {
	const { disk, registry, handle, clock } = autoSetup();
	type(handle, 0, "a");
	const release = disk.hold();
	registry.flush(handle.key);
	registry.prune(new Set());
	registry.prune(new Set([handle.key]));
	type(handle, 0, "b");
	registry.prune(new Set());
	release();
	await settle();
	await settle();
	expect(disk.text(PATH)).toBe("baone\ntwo\n");
	expect(registry.get(handle.key)).toBeNull();
	expect(clock.timers()).toBe(0);
});

test("a read-only file is not retried by autosave, only by an explicit save", async () => {
	const { disk, registry, handle, clock, summaries } = autoSetup();
	const write = disk.io.write;
	disk.io.write = async (params) => {
		disk.writes.push(params);
		return { status: "readonly" };
	};
	for (const at of [0, 1, 2]) {
		type(handle, at, "a");
		clock.advance(AUTOSAVE_MS);
		await settle();
	}
	expect(disk.writes).toHaveLength(1);
	expect(clock.timers()).toBe(0);
	expect(summaries.at(-1)).toEqual({ status: "readonly", dirty: true });
	disk.io.write = write;
	await registry.save(handle.key);
	expect(disk.text(PATH)).toBe("aaaone\ntwo\n");
});

test("an edit in a file autosave cannot write arms no timer", async () => {
	const { disk, handle, clock, summaries } = autoSetup();
	type(handle, 0, "mine ");
	disk.put(PATH, "theirs\ntwo\n");
	handle.adoptRead(disk.content(PATH), handle.readToken());
	clock.advance(AUTOSAVE_MS);
	await settle();
	const before = summaries.length;
	type(handle, 0, "x");
	expect(clock.timers()).toBe(0);
	expect(summaries.slice(before).some((summary) => summary?.pending)).toBe(false);
	expect(disk.writes).toHaveLength(0);
});

test("a save that throws while disconnected resumes on reconnect", async () => {
	let connected = true;
	const { disk, registry, handle, clock, summaries } = autoSetup({ connected: () => connected });
	const write = disk.io.write;
	disk.io.write = async () => {
		connected = false;
		throw new Error("fs.writeFile timed out");
	};
	type(handle, 0, "a");
	clock.advance(AUTOSAVE_MS);
	await settle();
	expect(summaries.at(-1)).toMatchObject({ status: "error", error: "offline" });
	disk.io.write = write;
	connected = true;
	await registry.reconcileAll();
	clock.advance(AUTOSAVE_MS);
	await settle();
	expect(disk.text(PATH)).toBe("aone\ntwo\n");
});

test("the first keystroke of a burst publishes one summary, already pending", () => {
	const { handle, summaries } = autoSetup();
	const before = summaries.length;
	type(handle, 0, "a");
	expect(summaries.slice(before)).toEqual([{ status: "dirty", dirty: true, pending: true }]);
});

test("a file recreated on disk after the timer fired while it was deleted autosaves again", async () => {
	const { disk, handle, clock, summaries } = autoSetup();
	type(handle, 0, "a");
	disk.remove(PATH);
	handle.readFailed(notFound());
	clock.advance(AUTOSAVE_MS);
	await settle();
	expect(clock.timers()).toBe(0);
	disk.put(PATH, "one\ntwo\n");
	handle.adoptRead(disk.content(PATH), handle.readToken());
	expect(summaries.at(-1)).toEqual({ status: "dirty", dirty: true, pending: true });
	clock.advance(AUTOSAVE_MS);
	await settle();
	expect(disk.writes).toHaveLength(1);
	expect(disk.text(PATH)).toBe("aone\ntwo\n");
});

test("a read never resumes a file paused by a thrown save error, nor does switching to auto", async () => {
	const { disk, handle, clock, setMode } = autoSetup();
	const write = disk.io.write;
	disk.io.write = async () => {
		throw new Error("socket closed");
	};
	type(handle, 0, "a");
	clock.advance(AUTOSAVE_MS);
	await settle();
	disk.io.write = write;
	handle.adoptRead(disk.content(PATH), handle.readToken());
	setMode("manual");
	setMode("auto");
	clock.advance(AUTOSAVE_MS * 3);
	await settle();
	expect(clock.timers()).toBe(0);
	expect(disk.writes).toHaveLength(0);
});

test("a flush while a save runs queues the newer edit behind it", async () => {
	const { disk, registry, handle, clock } = autoSetup();
	type(handle, 0, "a");
	const release = disk.hold();
	clock.advance(AUTOSAVE_MS);
	type(handle, 1, "b");
	registry.flushAll();
	expect(disk.writes).toHaveLength(1);
	release();
	await settle();
	expect(disk.writes.map((write) => write.content)).toEqual(["aone\ntwo\n", "abone\ntwo\n"]);
});
