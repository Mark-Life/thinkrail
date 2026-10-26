import { expect, test } from "bun:test";
import type { FileSaveMode } from "@thinkrail/contracts";
import type { FileBufferSummary } from "../store";
import { closeAction, saveBeforeClose } from "./fileCloseGuard";

const FILE = { workspaceId: "ws", path: "a.ts" };
const never = new Promise<void>(() => {});

const action = (summary: FileBufferSummary | null, fileSaveMode: FileSaveMode) =>
	closeAction(
		{ fileSaveMode, fileBuffersByWorkspace: summary ? { ws: { "a.ts": summary } } : {} },
		FILE,
	);

test("auto mode saves first while a write is coming or running; a paused file asks", () => {
	expect(action(null, "auto")).toBe("close");
	expect(action({ status: "dirty", dirty: true, pending: true }, "auto")).toBe("saveFirst");
	expect(action({ status: "saving", dirty: true }, "auto")).toBe("saveFirst");
	expect(action({ status: "dirty", dirty: true }, "auto")).toBe("ask");
	expect(action({ status: "conflict", dirty: true, pending: true }, "auto")).toBe("ask");
});

test("manual mode asks for every unsaved file", () => {
	expect(action({ status: "saving", dirty: true }, "manual")).toBe("ask");
	expect(action({ status: "dirty", dirty: true }, "manual")).toBe("ask");
	expect(action({ status: "clean", dirty: false }, "manual")).toBe("close");
});

test("an edit typed while the close-time save runs is saved too, and the guard never opens", async () => {
	let summary: FileBufferSummary = { status: "saving", dirty: true };
	const saves: (() => void)[] = [];
	const events: string[] = [];
	const done = saveBeforeClose({
		file: FILE,
		closing: new Set(),
		save: () => new Promise<void>((resolve) => saves.push(resolve)),
		state: () => ({ fileSaveMode: "auto", fileBuffersByWorkspace: { ws: { "a.ts": summary } } }),
		close: () => events.push("close"),
		ask: () => events.push("ask"),
		patience: never,
	});
	summary = { status: "dirty", dirty: true, pending: true };
	saves[0]?.();
	await Bun.sleep(0);
	expect(saves).toHaveLength(2);
	summary = { status: "clean", dirty: false };
	saves[1]?.();
	await done;
	expect(events).toEqual(["close"]);
});

test("a save that leaves the file paused opens the guard", async () => {
	const events: string[] = [];
	await saveBeforeClose({
		file: FILE,
		closing: new Set(),
		save: () => Promise.reject(new Error("socket closed")),
		state: () => ({
			fileSaveMode: "auto",
			fileBuffersByWorkspace: { ws: { "a.ts": { status: "error", dirty: true, error: "failed" } } },
		}),
		close: () => events.push("close"),
		ask: () => events.push("ask"),
		patience: never,
	});
	expect(events).toEqual(["ask"]);
});

test("a second close click while the first save runs starts no save and closes once", async () => {
	let summary: FileBufferSummary = { status: "dirty", dirty: true, pending: true };
	const saves: (() => void)[] = [];
	let closes = 0;
	const request = () =>
		saveBeforeClose({
			file: FILE,
			closing,
			save: () => new Promise<void>((resolve) => saves.push(resolve)),
			state: () => ({ fileSaveMode: "auto", fileBuffersByWorkspace: { ws: { "a.ts": summary } } }),
			close: () => {
				closes += 1;
			},
			ask: () => {},
			patience: never,
		});
	const closing = new Set<string>();
	const first = request();
	await request();
	expect(saves).toHaveLength(1);
	summary = { status: "clean", dirty: false };
	saves[0]?.();
	await first;
	expect(closes).toBe(1);
	expect(closing.size).toBe(0);
});

test("a save that never answers opens the guard once patience runs out, and its late answer does nothing", async () => {
	const events: string[] = [];
	const closing = new Set<string>();
	let answer = () => {};
	let giveUp = () => {};
	const done = saveBeforeClose({
		file: FILE,
		closing,
		save: () => new Promise<void>((resolve) => (answer = resolve)),
		state: () => ({
			fileSaveMode: "auto",
			fileBuffersByWorkspace: { ws: { "a.ts": { status: "saving", dirty: true } } },
		}),
		close: () => events.push("close"),
		ask: () => events.push("ask"),
		patience: new Promise<void>((resolve) => (giveUp = resolve)),
	});
	await Bun.sleep(0);
	expect(events).toEqual([]);
	giveUp();
	await done;
	expect(events).toEqual(["ask"]);
	expect(closing.size).toBe(0);
	answer();
	await Bun.sleep(0);
	expect(events).toEqual(["ask"]);
});
