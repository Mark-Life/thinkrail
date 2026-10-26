import type {
	FileContent,
	FileSaveMode,
	FileWriteResult,
	ResourceMeta,
	WsParams,
} from "@thinkrail/contracts";
import type { EditUpdate, ResourceEditSession } from "@thinkrail/resource-renderers";
import type { FileBufferError, FileBufferSummary } from "../store";
import { wsErrorCode } from "../transport";
import { createAutosave, type Schedule, timerSchedule } from "./autosave";
import {
	adoptDisk,
	type BufferState,
	beginSave,
	bufferSummary,
	bufferText,
	canAutosave,
	createBuffer,
	draftBaseHash,
	draftConflicts,
	editorDisk,
	failSave,
	finishSave,
	isDirty,
	keepMine,
	localEdit,
	markError,
	markMissing,
	reloadFromDisk,
	resolveConflict,
	restoreDraft,
	withDoc,
} from "./buffer";
import type { DraftKey, DraftOwner, DraftStore } from "./drafts";
import {
	canRedoDoc,
	canUndoDoc,
	conflictsOf,
	docChanges,
	docSelection,
	redoDoc,
	selectDoc,
	undoDoc,
} from "./history";
import { fileBufferKey } from "./keys";

export interface FileIo {
	read(workspaceId: string, path: string): Promise<FileContent>;
	write(params: WsParams<"fs.writeFile">): Promise<FileWriteResult>;
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
	saveMode(): FileSaveMode;
	autosaveDelayMs: number;
	schedule?: Schedule;
}

export interface FileBufferHandle {
	key: string;
	session: ResourceEditSession;
	subscribeText(listener: () => void): () => void;
	readToken(): number;
	adoptRead(file: FileContent, token: number): void;
	readFailed(error: unknown, token: number): void;
	reload(): void;
	keepMine(): void;
}

interface Entry {
	key: string;
	workspaceId: string;
	path: string;
	state: BufferState;
	views: Set<(update: EditUpdate) => void>;
	watchers: Set<() => void>;
	readSeq: number;
	landedRead: number;
	writeFloor: number;
	rereadAfterSave: boolean;
	draftTimer: ReturnType<typeof setTimeout> | null;
	dropped: boolean;
	pendingSave: Promise<void> | null;
	nextSave: Promise<void> | null;
	composing: boolean;
	afterCompose: "read" | "save" | null;
	leaving: boolean;
	handle: FileBufferHandle;
}

type CommitOrigin = "view" | "history" | "other";

function saveError(error: unknown): FileBufferError {
	const code = wsErrorCode(error);
	if (code === "NOT_EDITABLE") return "notEditable";
	if (code === "FILE_TOO_LARGE") return "tooLarge";
	return "failed";
}

export function createBufferRegistry(deps: RegistryDeps) {
	const entries = new Map<string, Entry>();
	const entryListeners = new Set<() => void>();
	let openKeys: ReadonlySet<string> | null = null;

	const publish = (entry: Entry) =>
		deps.publish(entry.workspaceId, entry.path, {
			...bufferSummary(entry.state),
			...(autosave.isArmed(entry.key) ? { pending: true as const } : {}),
		});

	const autosave = createAutosave({
		delayMs: deps.autosaveDelayMs,
		schedule: deps.schedule ?? timerSchedule,
		fire: (key) => {
			const entry = entries.get(key);
			if (!entry) return;
			if (entry.composing) autosave.arm(key);
			else if (canAutosave(entry.state)) void save(entry);
		},
		changed: (key) => {
			const entry = entries.get(key);
			if (entry && !entry.dropped) publish(entry);
		},
	});

	const autosaving = () => deps.saveMode() === "auto";

	const armIfReady = (entry: Entry) => {
		if (
			autosaving() &&
			canAutosave(entry.state) &&
			entry.state.issue === null &&
			isDirty(entry.state)
		)
			autosave.arm(entry.key);
	};

	const draftKey = (entry: Entry): DraftKey => ({
		host: deps.hostKey(),
		workspaceId: entry.workspaceId,
		path: entry.path,
	});

	const writeDraft = (entry: Entry) => {
		if (entry.draftTimer !== null) clearTimeout(entry.draftTimer);
		entry.draftTimer = null;
		if (!isDirty(entry.state)) return deps.drafts.remove(draftKey(entry), deps.draftOwner.id);
		const conflicts = draftConflicts(entry.state);
		return deps.drafts.put(draftKey(entry), {
			text: bufferText(entry.state),
			baseHash: draftBaseHash(entry.state),
			owner: deps.draftOwner.id,
			...(conflicts.length > 0 ? { conflicts } : {}),
		});
	};

	const scheduleDraft = (entry: Entry) => {
		if (!isDirty(entry.state)) {
			void writeDraft(entry);
			return;
		}
		if (entry.draftTimer !== null) clearTimeout(entry.draftTimer);
		entry.draftTimer = setTimeout(() => void writeDraft(entry), deps.draftDelayMs);
	};

	const broadcast = (entry: Entry, previous: BufferState, origin: CommitOrigin) => {
		const next = entry.state;
		const textChanged = bufferText(next) !== bufferText(previous);
		if (origin === "view" || entry.views.size === 0) return;
		if (!textChanged && conflictsOf(next.doc) === conflictsOf(previous.doc)) return;
		const changes = textChanged ? docChanges(previous.doc, next.doc) : [];
		const update: EditUpdate =
			origin === "history" ? { changes, selection: docSelection(next.doc) } : { changes };
		for (const view of entry.views) view(update);
	};

	const commit = (entry: Entry, next: BufferState, origin: CommitOrigin) => {
		const previous = entry.state;
		if (next === previous || entry.dropped) return false;
		entry.state = next;
		broadcast(entry, previous, origin);
		if (bufferText(next) !== bufferText(previous)) {
			for (const watcher of entry.watchers) watcher();
		}
		if (
			bufferText(next) !== bufferText(previous) ||
			draftBaseHash(next) !== draftBaseHash(previous) ||
			conflictsOf(next.doc) !== conflictsOf(previous.doc)
		) {
			scheduleDraft(entry);
		}
		publish(entry);
		return true;
	};

	const userStep = (entry: Entry, next: BufferState, origin: CommitOrigin) => {
		if (commit(entry, next, origin) && autosaving() && canAutosave(entry.state))
			autosave.arm(entry.key);
	};

	const notifyEntries = () => {
		for (const listener of entryListeners) listener();
	};

	const drop = (entry: Entry, discard: boolean) => {
		if (entry.dropped) return;
		autosave.cancel(entry.key);
		if (discard) {
			if (entry.draftTimer !== null) clearTimeout(entry.draftTimer);
			entry.draftTimer = null;
			void deps.drafts.remove(draftKey(entry), deps.draftOwner.id);
		} else if (entry.draftTimer !== null) {
			void writeDraft(entry);
		}
		entry.dropped = true;
		entries.delete(entry.key);
		deps.publish(entry.workspaceId, entry.path, null);
		notifyEntries();
	};

	const leave = (entry: Entry) => {
		autosave.flush(entry.key);
		const saving = entry.nextSave ?? entry.pendingSave;
		if (!saving) {
			drop(entry, false);
			return;
		}
		entry.leaving = true;
		void saving.finally(() => {
			entry.leaving = false;
			if (!openKeys?.has(entry.key)) leave(entry);
		});
	};

	const readToken = (entry: Entry) => {
		entry.readSeq += 1;
		return entry.readSeq;
	};

	const reread = (entry: Entry): Promise<void> => {
		const token = readToken(entry);
		return deps.io.read(entry.workspaceId, entry.path).then(
			(file) => adoptRead(entry, file, token),
			(error: unknown) => readFailed(entry, error, token),
		);
	};

	const lands = (entry: Entry, token: number) => {
		if (entry.dropped) return false;
		if (entry.state.saving) {
			entry.rereadAfterSave = true;
			return false;
		}
		if (token < entry.landedRead) return false;
		if (token < entry.writeFloor) {
			void reread(entry);
			return false;
		}
		entry.landedRead = token;
		return true;
	};

	const readFailed = (entry: Entry, error: unknown, token: number) => {
		if (wsErrorCode(error) !== "FILE_NOT_FOUND" || !lands(entry, token)) return;
		commit(entry, markMissing(entry.state), "other");
	};

	const adoptRead = (entry: Entry, file: FileContent, token: number) => {
		if (entry.dropped) return;
		if (entry.composing) {
			entry.afterCompose ??= "read";
			return;
		}
		if (!lands(entry, token)) return;
		const disk = editorDisk(file);
		commit(
			entry,
			disk ? adoptDisk(entry.state, disk) : markError(entry.state, "notEditable"),
			"other",
		);
	};

	const runSave = async (entry: Entry, retried = false): Promise<void> => {
		if (entry.dropped) return;
		const { state, request } = beginSave(entry.state);
		if (request && !deps.isConnected()) {
			commit(entry, markError(entry.state, "offline"), "other");
			return;
		}
		commit(entry, state, "other");
		if (!request) return;
		let retry = false;
		try {
			const result = await deps.io.write({
				workspaceId: entry.workspaceId,
				path: entry.path,
				content: request.content,
				expect: request.expect,
			});
			if (result.status === "stale" && entry.composing) {
				commit(entry, { ...entry.state, saving: null }, "other");
				entry.afterCompose = "save";
				entry.rereadAfterSave = false;
				return;
			}
			const next = finishSave(entry.state, result);
			retry =
				result.status === "stale" &&
				next.issue === null &&
				conflictsOf(next.doc).length === 0 &&
				isDirty(next);
			commit(entry, next, "other");
		} catch (error) {
			const reason = deps.isConnected() ? saveError(error) : "offline";
			commit(entry, failSave(entry.state, reason), "other");
		} finally {
			entry.writeFloor = entry.readSeq + 1;
		}
		if (retry && !retried && !entry.dropped) await runSave(entry, true);
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

	const setComposing = (entry: Entry, composing: boolean) => {
		entry.composing = composing;
		const after = entry.afterCompose;
		if (composing || after === null || entry.dropped) return;
		entry.afterCompose = null;
		void reread(entry).then(() => (after === "save" ? save(entry) : undefined));
	};

	const loadDraft = async (entry: Entry) => {
		const draft = await deps.drafts.get(draftKey(entry));
		if (!draft || entry.dropped) return;
		const { draftOwner } = deps;
		if (draft.owner !== draftOwner.id && (await draftOwner.isAlive(draft.owner))) return;
		if (entry.dropped) return;
		if (draft.text === bufferText(entry.state)) {
			void deps.drafts.remove(draftKey(entry), draft.owner);
			return;
		}
		const next = restoreDraft(entry.state, draft);
		if (next === entry.state) return;
		commit(entry, next, "other");
		void writeDraft(entry);
		armIfReady(entry);
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
			readSeq: 0,
			landedRead: 0,
			writeFloor: 0,
			rereadAfterSave: false,
			draftTimer: null,
			dropped: false,
			pendingSave: null,
			nextSave: null,
			composing: false,
			afterCompose: null,
			leaving: false,
			handle: {
				key,
				session: {
					snapshot: () => bufferText(entry.state),
					applyLocal: (changes, kind) =>
						userStep(entry, localEdit(entry.state, changes, kind), "view"),
					select: (ranges) => {
						if (!entry.dropped)
							entry.state = withDoc(entry.state, selectDoc(entry.state.doc, ranges));
					},
					subscribe: (listener) => {
						entry.views.add(listener);
						return () => entry.views.delete(listener);
					},
					undo: () => userStep(entry, withDoc(entry.state, undoDoc(entry.state.doc)), "history"),
					redo: () => userStep(entry, withDoc(entry.state, redoDoc(entry.state.doc)), "history"),
					canUndo: () => canUndoDoc(entry.state.doc),
					canRedo: () => canRedoDoc(entry.state.doc),
					setComposing: (composing) => setComposing(entry, composing),
					conflicts: () => conflictsOf(entry.state.doc),
					resolveConflict: (id, choice) =>
						userStep(entry, resolveConflict(entry.state, id, choice), "other"),
				},
				subscribeText: (listener) => {
					entry.watchers.add(listener);
					return () => entry.watchers.delete(listener);
				},
				readToken: () => readToken(entry),
				adoptRead: (file, token) => adoptRead(entry, file, token),
				readFailed: (error, token) => readFailed(entry, error, token),
				reload: () => commit(entry, reloadFromDisk(entry.state), "other"),
				keepMine: () => userStep(entry, keepMine(entry.state), "other"),
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
			publish(entry);
			notifyEntries();
			void loadDraft(entry);
			return entry.handle;
		},
		async save(key: string): Promise<FileBufferSummary | null> {
			const entry = entries.get(key);
			if (!entry) return null;
			autosave.cancel(key);
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
		prune(open: ReadonlySet<string>) {
			openKeys = open;
			for (const entry of [...entries.values()]) {
				if (open.has(entry.key)) continue;
				if (entry.leaving) autosave.flush(entry.key);
				else leave(entry);
			}
		},
		reconcileAll: () =>
			Promise.all(
				[...entries.values()].map((entry) => {
					const owed = entry.state.issue?.kind === "error" && entry.state.issue.error === "offline";
					return reread(entry).then(() => {
						if (owed) armIfReady(entry);
					});
				}),
			).then(() => {}),
		flush: (key: string) => autosave.flush(key),
		flushAll: () => autosave.flushAll(),
		saveModeChanged() {
			if (!autosaving()) {
				autosave.cancelAll();
				return;
			}
			for (const entry of entries.values()) armIfReady(entry);
		},
		async flushDrafts() {
			const pending = [...entries.values()].filter((entry) => entry.draftTimer !== null);
			await Promise.all(pending.map(writeDraft));
		},
	};
}

export type BufferRegistry = ReturnType<typeof createBufferRegistry>;
