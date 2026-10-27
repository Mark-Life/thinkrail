import { afterAll, expect, mock, test } from "bun:test";
import * as real from "./textChanges";

const { applyChanges, textChanges } = real;
let diffs = 0;
mock.module("./textChanges", () => ({
	applyChanges,
	textChanges: (...args: Parameters<typeof textChanges>) => {
		diffs += 1;
		return textChanges(...args);
	},
}));
afterAll(() => {
	mock.module("./textChanges", () => ({ applyChanges, textChanges }));
});

test("a buffer with no editor attached follows the disk without a line diff", async () => {
	const { PATH, setup } = await import("./registryFixtures");
	const { disk, handle } = setup({ text: "one\n", view: false });
	disk.put(PATH, "two\n");
	handle.adoptRead(disk.content(PATH), handle.readToken());
	expect(handle.session.snapshot()).toBe("two\n");
	expect(diffs).toBe(0);
	handle.session.subscribe(() => {});
	disk.put(PATH, "three\n");
	handle.adoptRead(disk.content(PATH), handle.readToken());
	expect(diffs).toBe(1);
});
