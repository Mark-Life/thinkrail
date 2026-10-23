import type { FileContent, FileWriteResult, ResourceMeta, WsParams } from "@thinkrail/contracts";
import type { ResourceEditSession, TextChange } from "@thinkrail/resource-renderers";
import { tupleKey } from "../lib";
import type { FileBufferSummary } from "../store";
import {
	adoptDisk,
	type BufferState,
	beginSave,
	bufferSummary,
	createBuffer,
	editorDisk,
	failSave,
	finishSave,
	isDirty,
	keepMine,
	localEdit,
	markMissing,
	markNotEditable,
	reloadFromDisk,
	restoreDraft,
} from "./buffer";
import type { DraftKey, DraftStore } from "./drafts";
import { applyChanges, textChanges } from "./textChanges";

export interface FileIo {
	read(workspaceId: string, path: string): Promise<FileContent>;
	write(params: WsParams<"fs.writeFile">): Promise<FileWriteResult>;
	exists(workspaceId: string, path: string): Promise<boolean>;
}

export interface RegistryDeps {
	io: FileIo;
	drafts: DraftStore;
	publish(workspaceId: string, path: string, summary: FileBufferSummary | null): void;
	hostKey(): string;
	canWrite(): boolean;
	onDraftRestored(path: string): void;
	draftDelayMs: number;
	now(): number;
}

export interface FileBufferHandle {
	key: string;
	session: ResourceEditSession;
	subscribeText(listener: () => void): () => void;
	readToken(): number;
	adoptRead(file: FileContent, token: number): void;
	readFailed(): void;
	reload(): void;
	keepMine(): void;
}

interface Entry {
	key: string;
	workspaceId: string;
	path: string;
	state: BufferState;
	views: Set<(changes: readonly TextChange[]) => void>;
	watchers: Set<() => void>;
	saveSeq: number;
	rereadAfterSave: boolean;
	draftTimer: ReturnType<typeof setTimeout> | null;
	dropped: boolean;
	pendingSave: Promise<void> | null;
	handle: FileBufferHandle;
}

export function fileBufferKey(workspaceId: string, path: string): string {
	return tupleKey("file-buffer", workspaceId, path);
}

const SAVING_TOKEN = -1;

export function createBufferRegistry(deps: RegistryDeps) {
	const entries = new Map<string, Entry>();
	const entryListeners = new Set<() => void>();

	const draftKey = (entry: Entry): DraftKey => ({
		host: deps.hostKey(),
		workspaceId: entry.workspaceId,
		path: entry.path,
	});

	const writeDraft = (entry: Entry) => {
		if (entry.draftTimer !== null) clearTimeout(entry.draftTimer);
		entry.draftTimer = null;
		if (!isDirty(entry.state)) {
			void deps.drafts.remove(draftKey(entry));
			return;
		}
		void deps.drafts.put(draftKey(entry), {
			text: entry.state.text,
			baseHash: entry.state.base.hash,
			savedAt: deps.now(),
		});
	};

	const scheduleDraft = (entry: Entry) => {
		if (!isDirty(entry.state)) {
			writeDraft(entry);
			return;
		}
		if (entry.draftTimer !== null) clearTimeout(entry.draftTimer);
		entry.draftTimer = setTimeout(() => writeDraft(entry), deps.draftDelayMs);
	};

	const commit = (entry: Entry, next: BufferState, fromView: boolean) => {
		const previous = entry.state;
		if (next === previous || entry.dropped) return;
		entry.state = next;
		if (next.text !== previous.text) {
			if (!fromView) {
				const changes = textChanges(previous.text, next.text);
				for (const view of entry.views) view(changes);
			}
			for (const watcher of entry.watchers) watcher();
		}
		if (next.text !== previous.text || next.base.hash !== previous.base.hash) {
			scheduleDraft(entry);
		}
		deps.publish(entry.workspaceId, entry.path, bufferSummary(next));
	};

	const notifyEntries = () => {
		for (const listener of entryListeners) listener();
	};

	const drop = (entry: Entry, discard: boolean) => {
		if (entry.dropped) return;
		if (discard) {
			if (entry.draftTimer !== null) clearTimeout(entry.draftTimer);
			entry.draftTimer = null;
			void deps.drafts.remove(draftKey(entry));
		} else if (entry.draftTimer !== null) {
			writeDraft(entry);
		}
		entry.dropped = true;
		entries.delete(entry.key);
		deps.publish(entry.workspaceId, entry.path, null);
		notifyEntries();
	};

	const readFailed = (entry: Entry) => {
		if (entry.state.saving) {
			entry.rereadAfterSave = true;
			return;
		}
		void deps.io
			.exists(entry.workspaceId, entry.path)
			.then((exists) => {
				if (!exists) commit(entry, markMissing(entry.state), false);
			})
			.catch(() => {});
	};

	const readToken = (entry: Entry) => (entry.state.saving ? SAVING_TOKEN : entry.saveSeq);

	const reread = (entry: Entry): Promise<void> => {
		const token = readToken(entry);
		return deps.io.read(entry.workspaceId, entry.path).then(
			(file) => adoptRead(entry, file, token),
			() => readFailed(entry),
		);
	};

	const adoptRead = (entry: Entry, file: FileContent, token: number) => {
		if (entry.dropped) return;
		if (entry.state.saving) {
			entry.rereadAfterSave = true;
			return;
		}
		if (token !== entry.saveSeq) {
			void reread(entry);
			return;
		}
		const disk = editorDisk(file);
		commit(entry, disk ? adoptDisk(entry.state, disk) : markNotEditable(entry.state), false);
	};

	const runSave = async (entry: Entry) => {
		const { state, request } = beginSave(entry.state);
		commit(entry, state, false);
		if (!request) return;
		entry.saveSeq += 1;
		try {
			const result = await deps.io.write({
				workspaceId: entry.workspaceId,
				path: entry.path,
				content: request.content,
				expect: request.expect,
			});
			commit(entry, finishSave(entry.state, result), false);
		} catch {
			commit(entry, failSave(entry.state), false);
		}
		if (entry.rereadAfterSave && !entry.dropped) {
			entry.rereadAfterSave = false;
			await reread(entry);
		}
	};

	const save = (entry: Entry) => {
		if (!deps.canWrite()) return Promise.resolve();
		if (entry.pendingSave) return entry.pendingSave;
		const pending = runSave(entry).finally(() => {
			if (entry.pendingSave === pending) entry.pendingSave = null;
		});
		entry.pendingSave = pending;
		return pending;
	};

	const loadDraft = (entry: Entry) => {
		void deps.drafts.get(draftKey(entry)).then((draft) => {
			if (!draft || entry.dropped) return;
			const next = restoreDraft(entry.state, draft);
			if (next === entry.state) return;
			commit(entry, next, false);
			deps.onDraftRestored(entry.path);
		});
	};

	const createEntry = (workspaceId: string, path: string, state: BufferState): Entry => {
		const key = fileBufferKey(workspaceId, path);
		const entry: Entry = {
			key,
			workspaceId,
			path,
			state,
			views: new Set(),
			watchers: new Set(),
			saveSeq: 0,
			rereadAfterSave: false,
			draftTimer: null,
			dropped: false,
			pendingSave: null,
			handle: {
				key,
				session: {
					snapshot: () => entry.state.text,
					applyLocal: (changes) =>
						commit(entry, localEdit(entry.state, applyChanges(entry.state.text, changes)), true),
					subscribe: (listener) => {
						entry.views.add(listener);
						return () => entry.views.delete(listener);
					},
					save: () => void save(entry),
				},
				subscribeText: (listener) => {
					entry.watchers.add(listener);
					return () => entry.watchers.delete(listener);
				},
				readToken: () => readToken(entry),
				adoptRead: (file, token) => adoptRead(entry, file, token),
				readFailed: () => readFailed(entry),
				reload: () => commit(entry, reloadFromDisk(entry.state), false),
				keepMine: () => commit(entry, keepMine(entry.state), false),
			},
		};
		return entry;
	};

	return {
		get: (key: string) => entries.get(key)?.handle ?? null,
		subscribeEntries: (listener: () => void) => {
			entryListeners.add(listener);
			return () => entryListeners.delete(listener);
		},
		ensure(input: { workspaceId: string; path: string; content: string; meta: ResourceMeta }) {
			const key = fileBufferKey(input.workspaceId, input.path);
			const existing = entries.get(key);
			if (existing) return existing.handle;
			const disk = editorDisk({ content: input.content, meta: input.meta });
			if (!disk) return null;
			const entry = createEntry(input.workspaceId, input.path, createBuffer(disk));
			entries.set(key, entry);
			deps.publish(entry.workspaceId, entry.path, bufferSummary(entry.state));
			notifyEntries();
			loadDraft(entry);
			return entry.handle;
		},
		isDirty: (key: string) => {
			const entry = entries.get(key);
			return entry ? isDirty(entry.state) : false;
		},
		async save(key: string): Promise<FileBufferSummary | null> {
			const entry = entries.get(key);
			if (!entry) return null;
			await save(entry);
			return bufferSummary(entry.state);
		},
		discard(key: string) {
			const entry = entries.get(key);
			if (entry) drop(entry, true);
		},
		prune(openKeys: ReadonlySet<string>) {
			for (const entry of [...entries.values()]) {
				if (!openKeys.has(entry.key)) drop(entry, false);
			}
		},
		reconcileAll: () => Promise.all([...entries.values()].map(reread)).then(() => {}),
		flushDrafts() {
			for (const entry of entries.values()) {
				if (entry.draftTimer !== null) writeDraft(entry);
			}
		},
	};
}

export type BufferRegistry = ReturnType<typeof createBufferRegistry>;
