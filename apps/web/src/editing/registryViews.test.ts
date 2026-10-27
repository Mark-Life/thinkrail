import { afterAll, expect, mock, test } from "bun:test";
import * as real from "./textChanges";

const { textChanges } = real;
let diffs = 0;
mock.module("./textChanges", () => ({
	...real,
	textChanges: (...args: Parameters<typeof textChanges>) => {
		diffs += 1;
		return textChanges(...args);
	},
}));
afterAll(() => {
	mock.module("./textChanges", () => ({ ...real }));
});

test("a disk change is diffed once, and an attached editor reuses that diff", async () => {
	const { PATH, setup } = await import("./registryFixtures");
	const { disk, handle } = setup({ text: "one\n", view: false });
	disk.put(PATH, "two\n");
	handle.adoptRead(disk.content(PATH), handle.readToken());
	expect(handle.session.snapshot()).toBe("two\n");
	expect(diffs).toBe(1);
	const updates: unknown[] = [];
	handle.session.subscribe((update) => updates.push(update));
	disk.put(PATH, "three\n");
	handle.adoptRead(disk.content(PATH), handle.readToken());
	expect(diffs).toBe(2);
	expect(updates).toEqual([{ changes: [{ from: 1, to: 3, insert: "hree" }] }]);
});

test("a merge into a dirty buffer reuses the merge's own changes instead of a second diff", async () => {
	const { PATH, setup, type } = await import("./registryFixtures");
	const { disk, handle, received } = setup({ text: "one\ntwo\n" });
	type(handle, 0, "mine ");
	const before = diffs;
	disk.put(PATH, "one\nTWO\n");
	handle.adoptRead(disk.content(PATH), handle.readToken());
	expect(diffs).toBe(before);
	expect(handle.session.snapshot()).toBe("mine one\nTWO\n");
	expect(received.at(-1)).toEqual([{ from: 9, to: 12, insert: "TWO" }]);
});
