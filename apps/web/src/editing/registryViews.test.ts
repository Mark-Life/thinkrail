import { expect, mock, test } from "bun:test";
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

test("a buffer with no editor attached follows the disk without a line diff", async () => {
	const { createBufferRegistry } = await import("./registry");
	const meta = (hash: string, text: string) => ({ hash, byteLength: text.length, text: true });
	const registry = createBufferRegistry({
		io: {
			read: () => Promise.reject(new Error("unused")),
			write: () => Promise.reject(new Error("unused")),
			exists: () => Promise.resolve(true),
		},
		drafts: {
			get: () => Promise.resolve(null),
			put: () => Promise.resolve(),
			remove: () => Promise.resolve(),
		},
		draftOwner: { id: "page", isAlive: () => Promise.resolve(false) },
		publish: () => {},
		hostKey: () => "http://host",
		canWrite: () => true,
		onDraftRestored: () => {},
		draftDelayMs: 5,
	});
	const handle = registry.ensure({
		workspaceId: "ws",
		path: "a.ts",
		content: "one\n",
		meta: meta("h1", "one\n"),
	});
	handle?.adoptRead({ content: "two\n", meta: meta("h2", "two\n") }, handle.readToken());
	expect(handle?.session.snapshot()).toBe("two\n");
	expect(diffs).toBe(0);
	handle?.session.subscribe(() => {});
	handle?.adoptRead({ content: "three\n", meta: meta("h3", "three\n") }, handle.readToken());
	expect(diffs).toBe(1);
});
