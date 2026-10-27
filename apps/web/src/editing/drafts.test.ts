import { afterEach, expect, test } from "bun:test";
import type { NativeDraft, NativeEditingBridge } from "@thinkrail/contracts";
import type { FileBufferSummary } from "../store";
import { nativeDrafts, nativeEditingBridge } from "./drafts";
import { hasUnsavedEdits } from "./files";
import { PATH, settle, setup, type, WS } from "./registryFixtures";

afterEach(() => {
	Reflect.deleteProperty(globalThis, "__THINKRAIL_NATIVE_EDITING__");
});

function desktopBridge() {
	const records = new Map<string, NativeDraft>();
	const id = (key: { workspaceId: string; path: string }) =>
		JSON.stringify([key.workspaceId, key.path]);
	const bridge: NativeEditingBridge = {
		getDraft: async (key) => records.get(id(key)) ?? null,
		putDraft: async (draft) => {
			records.set(id(draft), draft);
		},
		removeDraft: async (key) => {
			if (records.get(id(key))?.owner === key.owner) records.delete(id(key));
		},
		removeWorkspaceDrafts: async ({ workspaceId }) => {
			for (const [key, draft] of records)
				if (draft.workspaceId === workspaceId) records.delete(key);
		},
		setUnsavedEdits: () => {},
		onQuitFlush: () => {},
	};
	return { bridge, records };
}

test("a desktop draft is found again under a new window origin", async () => {
	const { bridge } = desktopBridge();
	const store = nativeDrafts(bridge);
	const draft = { text: "mine\n", baseHash: "h:1", owner: "page-a" };
	await store.put({ host: "http://127.0.0.1:4100", workspaceId: WS, path: PATH }, draft);
	expect(await store.get({ host: "http://127.0.0.1:5200", workspaceId: WS, path: PATH })).toEqual(
		draft,
	);
});

test("edits typed before a desktop quit come back after the restart", async () => {
	const { bridge, records } = desktopBridge();
	const drafts = { store: nativeDrafts(bridge), records: new Map() };
	const before = setup({ drafts, owner: "launch-1" });
	type(before.handle, 0, "mine ");
	await settle();
	expect(records.size).toBe(1);

	const after = setup({ disk: before.disk, drafts, owner: "launch-2" });
	await settle();
	expect(after.handle.session.snapshot()).toBe("mine one\ntwo\n");
	expect(after.restored).toEqual([PATH]);
});

test("a quit flush writes the draft of edits typed just before it", async () => {
	const { bridge, records } = desktopBridge();
	const slow: NativeEditingBridge = {
		...bridge,
		putDraft: async (draft) => {
			await new Promise((resolve) => setTimeout(resolve, 1));
			await bridge.putDraft(draft);
		},
	};
	const before = setup({ drafts: { store: nativeDrafts(slow), records: new Map() } });
	type(before.handle, 0, "mine ");
	expect(records.size).toBe(0);
	await before.registry.flushDrafts();
	expect([...records.values()].map((draft) => draft.text)).toEqual(["mine one\ntwo\n"]);
});

test("a failing bridge reads as no draft instead of breaking the buffer", async () => {
	const failing: NativeEditingBridge = {
		...desktopBridge().bridge,
		getDraft: () => Promise.reject(new Error("rpc timeout")),
	};
	const store = nativeDrafts(failing);
	expect(await store.get({ host: "h", workspaceId: WS, path: PATH })).toBeNull();
});

test("the editing bridge is read only when the desktop installed it", () => {
	expect(nativeEditingBridge()).toBeUndefined();
	const { bridge } = desktopBridge();
	Reflect.set(globalThis, "__THINKRAIL_NATIVE_EDITING__", bridge);
	expect(nativeEditingBridge()).toBe(bridge);
});

test("quit asks only for dirty files that will not save on their own", () => {
	const clean = { status: "clean", dirty: false } as const;
	const pending = { status: "dirty", dirty: true, pending: true } as const;
	const saving = { status: "saving", dirty: true } as const;
	const paused = { status: "stale", dirty: true } as const;
	const ask = (summaries: Record<string, FileBufferSummary>, fileSaveMode: "auto" | "manual") =>
		hasUnsavedEdits({ fileBuffersByWorkspace: { a: summaries }, fileSaveMode });
	expect(hasUnsavedEdits({ fileBuffersByWorkspace: {}, fileSaveMode: "manual" })).toBe(false);
	expect(ask({ "x.ts": clean }, "manual")).toBe(false);
	expect(ask({ "x.ts": pending, "y.ts": saving }, "auto")).toBe(false);
	expect(ask({ "x.ts": pending, "y.ts": paused }, "auto")).toBe(true);
	expect(ask({ "x.ts": pending }, "manual")).toBe(true);
});
