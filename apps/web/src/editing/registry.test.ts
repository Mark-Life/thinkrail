import { expect, test } from "bun:test";
import type { FileContent, FileWriteResult, WsParams } from "@thinkrail/contracts";
import type { TextChange } from "@thinkrail/resource-renderers";
import type { FileBufferSummary } from "../store";
import { RequestError } from "../transport";
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
		remove: async (key, owner) => {
			if (records.get(draftId(key))?.owner === owner) records.delete(draftId(key));
		},
	};
	return { store, records };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

const live = new Set<string>();

function setup(
	options: {
		text?: string;
		drafts?: ReturnType<typeof memoryDrafts>;
		disk?: ReturnType<typeof fakeDisk>;
		owner?: string;
	} = {},
) {
	const disk = options.disk ?? fakeDisk({ [PATH]: options.text ?? "one\ntwo\n" });
	const drafts = options.drafts ?? memoryDrafts();
	const owner = options.owner ?? "page-a";
	const summaries: (FileBufferSummary | null)[] = [];
	const restored: string[] = [];
	const registry = createBufferRegistry({
		io: disk.io,
		drafts: drafts.store,
		draftOwner: { id: owner, isAlive: async (id) => id === owner || live.has(id) },
		publish: (_workspaceId, _path, summary) => summaries.push(summary),
		hostKey: () => "http://host",
		canWrite: () => true,
		onDraftRestored: (path) => restored.push(path),
		draftDelayMs: 5,
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
		{ text: "xone\ntwo\n", baseHash: "rev-1", owner: "page-a" },
	]);
	await registry.save(handle.key);
	await settle();
	expect(drafts.records.size).toBe(0);
});

test("a buffer created again restores its draft and says so", async () => {
	const key = draftId({ host: "http://host", workspaceId: WS, path: PATH });
	const drafts = memoryDrafts({ [key]: { text: "draft\n", baseHash: "rev-1", owner: "page-a" } });
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

	const second = setup({ drafts, owner: "page-b" });
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

const draftKeyId = draftId({ host: "http://host", workspaceId: WS, path: PATH });

test("a draft equal to the buffer text is deleted, so it never comes back as a fake conflict", async () => {
	const drafts = memoryDrafts({
		[draftKeyId]: { text: "saved\n", baseHash: "rev-0", owner: "page-old" },
	});
	const disk = fakeDisk({ [PATH]: "saved\n" });
	const first = setup({ disk, drafts, owner: "page-b" });
	await settle();
	expect(first.restored).toEqual([]);
	expect(drafts.records.size).toBe(0);

	first.registry.discard(first.handle.key);
	disk.put(PATH, "agent\n");
	const second = setup({ disk, drafts, owner: "page-c" });
	await settle();
	expect(second.restored).toEqual([]);
	expect(second.summaries.at(-1)).toEqual({ status: "clean", dirty: false });
});

test("a buffer dropped while its save is in flight leaves no draft that resurrects", async () => {
	const disk = fakeDisk({ [PATH]: "one\n" });
	const drafts = memoryDrafts();
	const first = setup({ disk, drafts, owner: "page-a" });
	type(first.handle, 0, "saved ");
	const release = disk.hold();
	const saving = first.registry.save(first.handle.key);
	first.registry.prune(new Set());
	release();
	await saving;
	expect(drafts.records.size).toBe(1);

	const second = setup({ disk, drafts, owner: "page-b" });
	await settle();
	expect(drafts.records.size).toBe(0);
	second.registry.discard(second.handle.key);
	disk.put(PATH, "agent\n");
	const third = setup({ disk, drafts, owner: "page-c" });
	await settle();
	expect(third.restored).toEqual([]);
	expect(third.handle.session.snapshot()).toBe("agent\n");
});

test("a failed re-create of a deleted file shows why instead of 'deleted'", async () => {
	const { disk, registry, handle } = setup();
	disk.remove(PATH);
	handle.readFailed();
	await settle();
	type(handle, 0, "x");
	const write = disk.io.write;
	disk.io.write = async () => ({ status: "readonly" });
	expect(await registry.save(handle.key)).toEqual({ status: "readonly", dirty: true });
	disk.io.write = async () => {
		throw new Error("socket closed");
	};
	expect(await registry.save(handle.key)).toEqual({
		status: "error",
		dirty: true,
		error: "failed",
	});
	disk.io.write = write;
});

test("a NOT_EDITABLE save says so instead of asking for a retry", async () => {
	const { disk, registry, handle } = setup();
	type(handle, 0, "x");
	disk.io.write = async () => {
		throw new RequestError("NOT_EDITABLE", "src/a.ts is not a regular file");
	};
	expect(await registry.save(handle.key)).toEqual({
		status: "error",
		dirty: true,
		error: "notEditable",
	});
});

test("a failed probe leaves the buffer alone instead of marking it deleted", async () => {
	const { disk, handle, summaries, registry } = setup();
	type(handle, 0, "// ");
	disk.io.exists = () => Promise.reject(new Error("Request timed out"));
	handle.readFailed();
	await settle();
	expect(summaries.at(-1)).toEqual({ status: "dirty", dirty: true });
	await registry.reconcileAll();
	expect(summaries.at(-1)).toEqual({ status: "dirty", dirty: true });
});

test("an existence probe sent before a re-creating save cannot mark the file deleted again", async () => {
	const { disk, registry, handle, summaries } = setup();
	disk.remove(PATH);
	handle.readFailed();
	await settle();
	let answer = (_exists: boolean) => {};
	disk.io.exists = () =>
		new Promise<boolean>((resolve) => {
			answer = resolve;
		});
	handle.readFailed();
	expect(await registry.save(handle.key)).toEqual({ status: "clean", dirty: false });
	answer(false);
	await settle();
	expect(summaries.at(-1)).toEqual({ status: "clean", dirty: false });
});

test("a second window neither restores nor deletes the draft of a window still open", async () => {
	const disk = fakeDisk({ [PATH]: "one\ntwo\n" });
	const drafts = memoryDrafts();
	live.add("page-a");
	try {
		const a = setup({ disk, drafts, owner: "page-a" });
		type(a.handle, 0, "A ");
		await settle();
		const b = setup({ disk, drafts, owner: "page-b" });
		await settle();
		expect(b.restored).toEqual([]);
		expect(b.handle.session.snapshot()).toBe("one\ntwo\n");
		b.registry.discard(b.handle.key);
		await settle();
		expect([...drafts.records.values()]).toEqual([
			{ text: "A one\ntwo\n", baseHash: "rev-1", owner: "page-a" },
		]);
	} finally {
		live.delete("page-a");
	}
	const c = setup({ disk, drafts, owner: "page-c" });
	await settle();
	expect(c.restored).toEqual([PATH]);
	expect([...drafts.records.values()].map((draft) => draft.owner)).toEqual(["page-c"]);
});
