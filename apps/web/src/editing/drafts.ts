import type { NativeEditingBridge } from "@thinkrail/contracts";
import { randomId } from "../lib";
import type { MergeConflict } from "./merge3";

export interface DraftKey {
	host: string;
	workspaceId: string;
	path: string;
}

export interface Draft {
	text: string;
	baseHash: string | null;
	owner: string;
	conflicts?: MergeConflict[];
}

export interface DraftStore {
	get(key: DraftKey): Promise<Draft | null>;
	put(key: DraftKey, draft: Draft): Promise<void>;
	remove(key: DraftKey, owner: string): Promise<void>;
	removeWorkspace(key: Omit<DraftKey, "path">): Promise<void>;
}

export interface DraftOwner {
	id: string;
	isAlive(owner: string): Promise<boolean>;
}

const DATABASE = "thinkrail-drafts";
const STORE = "drafts";

function draftId({ host, workspaceId, path }: DraftKey): IDBValidKey {
	return [host, workspaceId, path];
}

function workspaceRange({ host, workspaceId }: Omit<DraftKey, "path">): IDBKeyRange {
	return IDBKeyRange.bound([host, workspaceId], [host, workspaceId, []]);
}

function isConflict(value: unknown): value is MergeConflict {
	if (typeof value !== "object" || value === null) return false;
	const from: unknown = Reflect.get(value, "from");
	const to: unknown = Reflect.get(value, "to");
	const theirs: unknown = Reflect.get(value, "theirs");
	const base: unknown = Reflect.get(value, "base");
	return (
		typeof from === "number" &&
		typeof to === "number" &&
		Number.isInteger(from) &&
		Number.isInteger(to) &&
		from >= 0 &&
		typeof theirs === "string" &&
		(base === undefined || typeof base === "string")
	);
}

function isDraft(value: unknown): value is Draft {
	if (typeof value !== "object" || value === null) return false;
	const text: unknown = Reflect.get(value, "text");
	const baseHash: unknown = Reflect.get(value, "baseHash");
	const owner: unknown = Reflect.get(value, "owner");
	const conflicts: unknown = Reflect.get(value, "conflicts");
	return (
		typeof text === "string" &&
		(typeof baseHash === "string" || baseHash === null) &&
		typeof owner === "string" &&
		(conflicts === undefined || (Array.isArray(conflicts) && conflicts.every(isConflict)))
	);
}

function settle<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

const OWNER_LOCK = "thinkrail-draft-owner:";

export function pageDraftOwner(
	locks: LockManager | undefined = globalThis.navigator?.locks,
): DraftOwner {
	const id = randomId("page");
	if (!locks) return { id, isAlive: (owner) => Promise.resolve(owner === id) };
	void locks.request(`${OWNER_LOCK}${id}`, () => new Promise<never>(() => {})).catch(() => {});
	return {
		id,
		isAlive: async (owner) => {
			if (owner === id) return true;
			const { held = [] } = await locks.query().catch(() => ({ held: [] }));
			return held.some((lock) => lock.name === `${OWNER_LOCK}${owner}`);
		},
	};
}

const NO_DRAFTS: DraftStore = {
	get: () => Promise.resolve(null),
	put: () => Promise.resolve(),
	remove: () => Promise.resolve(),
	removeWorkspace: () => Promise.resolve(),
};

export function indexedDbDrafts(
	factory: IDBFactory | undefined = globalThis.indexedDB,
): DraftStore {
	if (!factory) return NO_DRAFTS;
	let opening: Promise<IDBDatabase> | null = null;
	const database = () => {
		opening ??= new Promise<IDBDatabase>((resolve, reject) => {
			const request = factory.open(DATABASE, 1);
			request.onupgradeneeded = () => request.result.createObjectStore(STORE);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		opening.catch(() => {
			opening = null;
		});
		return opening;
	};
	const run = async <T>(
		mode: IDBTransactionMode,
		operation: (store: IDBObjectStore) => IDBRequest<T>,
	): Promise<T | undefined> => {
		try {
			const db = await database();
			return await settle(operation(db.transaction(STORE, mode).objectStore(STORE)));
		} catch (error) {
			console.warn("[editing] draft storage failed", error);
			return undefined;
		}
	};
	return {
		get: async (key) => {
			const value: unknown = await run("readonly", (store) => store.get(draftId(key)));
			return isDraft(value) ? value : null;
		},
		put: async (key, draft) => {
			await run("readwrite", (store) => store.put(draft, draftId(key)));
		},
		remove: async (key, owner) => {
			await run("readwrite", (store) => {
				const id = draftId(key);
				const request = store.get(id);
				request.addEventListener("success", () => {
					if (isDraft(request.result) && request.result.owner === owner) store.delete(id);
				});
				return request;
			});
		},
		removeWorkspace: async (key) => {
			await run("readwrite", (store) => store.delete(workspaceRange(key)));
		},
	};
}

const EDITING_BRIDGE_GLOBAL = "__THINKRAIL_NATIVE_EDITING__";

export function nativeEditingBridge(): NativeEditingBridge | undefined {
	const bridge: unknown = Reflect.get(globalThis, EDITING_BRIDGE_GLOBAL);
	return typeof bridge === "object" &&
		bridge !== null &&
		typeof Reflect.get(bridge, "getDraft") === "function"
		? (bridge as NativeEditingBridge)
		: undefined;
}

/** Drafts kept by the desktop shell, so they survive a quit even though the window origin changes. */
export function nativeDrafts(bridge: NativeEditingBridge): DraftStore {
	const quiet = async <T>(fallback: T, run: () => Promise<T>): Promise<T> => {
		try {
			return await run();
		} catch (error) {
			console.warn("[editing] draft storage failed", error);
			return fallback;
		}
	};
	return {
		get: ({ workspaceId, path }) =>
			quiet(null, async () => {
				const draft = await bridge.getDraft({ workspaceId, path });
				return draft && isDraft(draft)
					? { text: draft.text, baseHash: draft.baseHash, owner: draft.owner }
					: null;
			}),
		put: ({ workspaceId, path }, draft) =>
			quiet(undefined, () => bridge.putDraft({ workspaceId, path, ...draft })),
		remove: ({ workspaceId, path }, owner) =>
			quiet(undefined, () => bridge.removeDraft({ workspaceId, path, owner })),
		removeWorkspace: ({ workspaceId }) =>
			quiet(undefined, () => bridge.removeWorkspaceDrafts({ workspaceId })),
	};
}
