import type { FileContent, FileSaveMode, FileWriteResult, WsParams } from "@thinkrail/contracts";
import type { ResourceEditSession, TextChange } from "@thinkrail/resource-renderers";
import type { FileBufferSummary } from "../store";
import { RequestError } from "../transport";
import type { Schedule } from "./autosave";
import type { Draft, DraftKey, DraftStore } from "./drafts";
import { createBufferRegistry, type FileIo } from "./registry";

export const WS = "ws-1";
export const PATH = "src/a.ts";

export const draftRecordId = ({ host, workspaceId, path }: DraftKey) =>
	JSON.stringify([host, workspaceId, path]);

export const DRAFT_ID = draftRecordId({ host: "http://host", workspaceId: WS, path: PATH });

export function fakeDisk(initial: Record<string, string>) {
	let revision = 0;
	const files = new Map<string, { text: string; hash: string }>();
	const put = (path: string, text: string) => {
		revision += 1;
		files.set(path, { text, hash: `rev-${revision}` });
	};
	for (const [path, text] of Object.entries(initial)) put(path, text);
	const content = (path: string): FileContent => {
		const current = files.get(path);
		if (!current) throw new RequestError("FILE_NOT_FOUND", `${path} does not exist.`);
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

export function memoryDrafts(seed: Record<string, Draft> = {}) {
	const records = new Map(Object.entries(seed));
	const store: DraftStore = {
		get: async (key) => records.get(draftRecordId(key)) ?? null,
		put: async (key, draft) => {
			records.set(draftRecordId(key), draft);
		},
		remove: async (key, owner) => {
			if (records.get(draftRecordId(key))?.owner === owner) records.delete(draftRecordId(key));
		},
		removeWorkspace: async ({ host, workspaceId }) => {
			const prefix = JSON.stringify([host, workspaceId]).slice(0, -1);
			for (const id of [...records.keys()]) if (id.startsWith(`${prefix},`)) records.delete(id);
		},
	};
	return { store, records };
}

export const notFound = () => new RequestError("FILE_NOT_FOUND", `${PATH} does not exist.`);

export const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

export const live = new Set<string>();

export function fakeClock() {
	let now = 0;
	const timers = new Set<{ at: number; run: () => void }>();
	const schedule: Schedule = (run, ms) => {
		const timer = { at: now + ms, run };
		timers.add(timer);
		return () => timers.delete(timer);
	};
	const advance = (ms: number) => {
		now += ms;
		for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
			if (timer.at > now || !timers.has(timer)) continue;
			timers.delete(timer);
			timer.run();
		}
	};
	return { schedule, advance, timers: () => timers.size };
}

export const AUTOSAVE_MS = 1000;

export function setup(
	options: {
		text?: string;
		drafts?: ReturnType<typeof memoryDrafts>;
		disk?: ReturnType<typeof fakeDisk>;
		owner?: string;
		connected?: () => boolean;
		view?: boolean;
		mode?: () => FileSaveMode;
		clock?: ReturnType<typeof fakeClock>;
	} = {},
) {
	const disk = options.disk ?? fakeDisk({ [PATH]: options.text ?? "one\ntwo\n" });
	const drafts = options.drafts ?? memoryDrafts();
	const owner = options.owner ?? "page-a";
	const summaries: (FileBufferSummary | null)[] = [];
	const restored: string[] = [];
	const clock = options.clock ?? fakeClock();
	const registry = createBufferRegistry({
		io: disk.io,
		drafts: drafts.store,
		draftOwner: { id: owner, isAlive: async (id) => id === owner || live.has(id) },
		publish: (_workspaceId, _path, summary) => summaries.push(summary),
		hostKey: () => "http://host",
		canWrite: () => true,
		isConnected: options.connected ?? (() => true),
		onDraftRestored: (path) => restored.push(path),
		draftDelayMs: 5,
		saveMode: options.mode ?? (() => "manual"),
		autosaveDelayMs: AUTOSAVE_MS,
		schedule: clock.schedule,
	});
	const file = disk.content(PATH);
	const handle = registry.ensure({ workspaceId: WS, path: PATH, ...file });
	if (!handle) throw new Error("buffer not created");
	const received: (readonly TextChange[])[] = [];
	if (options.view !== false) handle.session.subscribe((update) => received.push(update.changes));
	return { disk, drafts, summaries, restored, registry, handle, received, clock };
}

export const type = (
	handle: { session: Pick<ResourceEditSession, "applyLocal"> },
	at: number,
	text: string,
) => handle.session.applyLocal([{ from: at, to: at, insert: text }], "type");
