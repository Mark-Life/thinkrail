import type { FileContent, FileWriteResult, ResourceMeta, WsParams } from "@thinkrail/contracts";
import type { ResourceEditSession, TextChange } from "@thinkrail/resource-renderers";
import { tupleKey } from "../lib";
import type { FileBufferError, FileBufferSummary } from "../store";
import { wsErrorCode } from "../transport";
import {
	adoptDisk,
	type BufferState,
	beginSave,
	bufferSummary,
	createBuffer,
	draftBaseHash,
	editorDisk,
	failSave,
	finishSave,
	isDirty,
	keepMine,
	localEdit,
	markError,
	markMissing,
	reloadFromDisk,
	restoreDraft,
} from "./buffer";
import type { DraftKey, DraftOwner, DraftStore } from "./drafts";
import { applyChanges, textChanges } from "./textChanges";

export interface FileIo {
	read(workspaceId: string, path: string): Promise<FileContent>;
	write(params: WsParams<"fs.writeFile">): Promise<FileWriteResult>;
	exists(workspaceId: string, path: string): Promise<boolean>;
}

interface RegistryDeps {
	io: FileIo;
	drafts: DraftStore;
	draftOwner: DraftOwner;
	publish(workspaceId: string, path: string, summary: FileBufferSummary | null): void;
	hostKey(): string;
	canWrite(): boolean;
	isConnected(): boolean;
	onDraftRestored(path: string): void;
	draftDelayMs: number;
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
	nextSave: Promise<void> | null;
	handle: FileBufferHandle;
}

export function fileBufferKey(workspaceId: string, path: string): string {
	return tupleKey("file-buffer", workspaceId, path);
}

const SAVING_TOKEN = -1;

function saveError(error: unknown): FileBufferError {
	const code = wsErrorCode(error);
	if (code === "NOT_EDITABLE") return "notEditable";
	if (code === "FILE_TOO_LARGE") return "tooLarge";
	return "failed";
}

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
			void deps.drafts.remove(draftKey(entry), deps.draftOwner.id);
			return;
		}
		void deps.drafts.put(draftKey(entry), {
			text: entry.state.text,
			baseHash: draftBaseHash(entry.state),
			owner: deps.draftOwner.id,
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
			if (!fromView && entry.views.size > 0) {
				const changes = textChanges(previous.text, next.text);
				for (const view of entry.views) view(changes);
			}
			for (const watcher of entry.watchers) watcher();
		}
		if (next.text !== previous.text || draftBaseHash(next) !== draftBaseHash(previous)) {
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
			void deps.drafts.remove(draftKey(entry), deps.draftOwner.id);
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
		const seq = entry.saveSeq;
		void deps.io
			.exists(entry.workspaceId, entry.path)
			.then((exists) => {
				if (!exists && seq === entry.saveSeq && !entry.state.saving) {
					commit(entry, markMissing(entry.state), false);
				}
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
		commit(
			entry,
			disk ? adoptDisk(entry.state, disk) : markError(entry.state, "notEditable"),
			false,
		);
	};

	const runSave = async (entry: Entry): Promise<void> => {
		if (entry.dropped) return;
		const { state, request } = beginSave(entry.state);
		if (request && !deps.isConnected()) {
			commit(entry, markError(entry.state, "offline"), false);
			return;
		}
		commit(entry, state, false);
		if (!request) return;
		entry.saveSeq += 1;
		let ownEcho = false;
		try {
			const result = await deps.io.write({
				workspaceId: entry.workspaceId,
				path: entry.path,
				content: request.content,
				expect: request.expect,
			});
			const next = finishSave(entry.state, result);
			ownEcho = result.status === "stale" && next.issue === null && isDirty(next);
			commit(entry, next, false);
		} catch (error) {
			commit(entry, failSave(entry.state, saveError(error)), false);
		}
		if (ownEcho && !entry.dropped) return runSave(entry);
		if (entry.rereadAfterSave && !entry.dropped) {
			entry.rereadAfterSave = false;
			await reread(entry);
		}
	};

	const save = (entry: Entry): Promise<void> => {
		if (!deps.canWrite()) return Promise.resolve();
		if (entry.pendingSave) {
			entry.nextSave ??= entry.pendingSave.then(() => {
				entry.nextSave = null;
				return save(entry);
			});
			return entry.nextSave;
		}
		const pending = runSave(entry).finally(() => {
			if (entry.pendingSave === pending) entry.pendingSave = null;
		});
		entry.pendingSave = pending;
		return pending;
	};

	const loadDraft = async (entry: Entry) => {
		const draft = await deps.drafts.get(draftKey(entry));
		if (!draft || entry.dropped) return;
		const { draftOwner } = deps;
		if (draft.owner !== draftOwner.id && (await draftOwner.isAlive(draft.owner))) return;
		if (entry.dropped) return;
		if (draft.text === entry.state.text) {
			void deps.drafts.remove(draftKey(entry), draft.owner);
			return;
		}
		const next = restoreDraft(entry.state, draft);
		if (next === entry.state) return;
		commit(entry, next, false);
		writeDraft(entry);
		deps.onDraftRestored(entry.path);
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
			nextSave: null,
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
			void loadDraft(entry);
			return entry.handle;
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
		forgetWorkspace(workspaceId: string) {
			for (const entry of [...entries.values()]) {
				if (entry.workspaceId === workspaceId) drop(entry, true);
			}
			void deps.drafts.removeWorkspace({ host: deps.hostKey(), workspaceId });
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
