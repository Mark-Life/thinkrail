import { expect, test } from "bun:test";
import type { FileContent, FileWriteResult, WsParams } from "@thinkrail/contracts";
import type { TextChange } from "@thinkrail/resource-renderers";
import type { FileBufferSummary } from "../store";
import type { Draft, DraftStore } from "./drafts";
import { draftId } from "./drafts";
import { createBufferRegistry, type FileIo } from "./registry";

const WS = "ws-1";
const PATH = "src/a.ts";

function fakeDisk(initial: Record<string, string>) {
	let revision = 0;
	const files = new Map<string, { text: string; hash: string }>();
	const put = (path: string, text: string) => {
		revision += 1;
		files.set(path, { text, hash: `rev-${revision}` });
	};
	for (const [path, text] of Object.entries(initial)) put(path, text);
	const content = (path: string): FileContent => {
		const current = files.get(path);
		if (!current) throw new Error(`ENOENT: ${path}`);
		return {
			content: current.text,
			meta: { hash: current.hash, byteLength: current.text.length, text: true },
		};
	};
	const writes: WsParams<"fs.writeFile">[] = [];
	let gate: Promise<void> | null = null;
	const io: FileIo = {
		read: async (_workspaceId, path) => content(path),
		write: async (params): Promise<FileWriteResult> => {
			writes.push(params);
			if (gate) await gate;
			const current = files.get(params.path);
			if (!current) {
				if (params.expect.hash !== null) return { status: "missing" };
				put(params.path, params.content);
				return { status: "written", meta: content(params.path).meta };
			}
			if (current.text === params.content)
				return { status: "written", meta: content(params.path).meta };
			if (current.hash !== params.expect.hash)
				return { status: "stale", current: content(params.path) };
			put(params.path, params.content);
			return { status: "written", meta: content(params.path).meta };
		},
		exists: async (_workspaceId, path) => files.has(path),
	};
	return {
		io,
		writes,
		put,
		remove: (path: string) => files.delete(path),
		text: (path: string) => files.get(path)?.text,
		content,
		hold() {
			let release = () => {};
			gate = new Promise<void>((resolve) => {
				release = () => {
					gate = null;
					resolve();
				};
			});
			return release;
		},
	};
}

function memoryDrafts(seed: Record<string, Draft> = {}) {
	const records = new Map(Object.entries(seed));
	const store: DraftStore = {
		get: async (key) => records.get(draftId(key)) ?? null,
		put: async (key, draft) => {
			records.set(draftId(key), draft);
		},
		remove: async (key) => {
			records.delete(draftId(key));
		},
	};
	return { store, records };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

function setup(options: { text?: string; drafts?: ReturnType<typeof memoryDrafts> } = {}) {
	const disk = fakeDisk({ [PATH]: options.text ?? "one\ntwo\n" });
	const drafts = options.drafts ?? memoryDrafts();
	const summaries: (FileBufferSummary | null)[] = [];
	const restored: string[] = [];
	const registry = createBufferRegistry({
		io: disk.io,
		drafts: drafts.store,
		publish: (_workspaceId, _path, summary) => summaries.push(summary),
		hostKey: () => "http://host",
		canWrite: () => true,
		onDraftRestored: (path) => restored.push(path),
		draftDelayMs: 5,
		now: () => 1,
	});
	const file = disk.content(PATH);
	const handle = registry.ensure({ workspaceId: WS, path: PATH, ...file });
	if (!handle) throw new Error("buffer not created");
	const received: (readonly TextChange[])[] = [];
	handle.session.subscribe((changes) => received.push(changes));
	return { disk, drafts, summaries, restored, registry, handle, received };
}

const type = (
	handle: { session: { snapshot(): string; applyLocal(c: TextChange[]): void } },
	at: number,
	text: string,
) => handle.session.applyLocal([{ from: at, to: at, insert: text }]);

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

test("a dirty buffer keeps its text on a disk change until Reload or Keep mine", async () => {
	const { disk, registry, handle, received, summaries } = setup();
	type(handle, 0, "mine ");
	disk.put(PATH, "theirs\n");
	handle.adoptRead(disk.content(PATH), handle.readToken());
	expect(handle.session.snapshot()).toBe("mine one\ntwo\n");
	expect(summaries.at(-1)?.status).toBe("stale");
	handle.keepMine();
	expect(summaries.at(-1)).toEqual({ status: "dirty", dirty: true });
	await registry.save(handle.key);
	expect(disk.text(PATH)).toBe("mine one\ntwo\n");
	disk.put(PATH, "agent\n");
	type(handle, 0, "x");
	handle.adoptRead(disk.content(PATH), handle.readToken());
	handle.reload();
	expect(handle.session.snapshot()).toBe("agent\n");
	expect(received.at(-1)).toBeDefined();
});

test("a stale save shows the conflict and writes nothing", async () => {
	const { disk, registry, handle } = setup();
	type(handle, 0, "mine ");
	disk.put(PATH, "agent wrote this\n");
	const summary = await registry.save(handle.key);
	expect(summary?.status).toBe("stale");
	expect(disk.text(PATH)).toBe("agent wrote this\n");
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
	handle.readFailed();
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
		{ text: "xone\ntwo\n", baseHash: "rev-1", savedAt: 1 },
	]);
	await registry.save(handle.key);
	await settle();
	expect(drafts.records.size).toBe(0);
});

test("a buffer created again restores its draft and says so", async () => {
	const key = draftId({ host: "http://host", workspaceId: WS, path: PATH });
	const drafts = memoryDrafts({ [key]: { text: "draft\n", baseHash: "rev-1", savedAt: 1 } });
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

	const second = setup({ drafts });
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
