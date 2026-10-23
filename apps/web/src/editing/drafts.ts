import { tupleKey } from "../lib";

export interface DraftKey {
	host: string;
	workspaceId: string;
	path: string;
}

export interface Draft {
	text: string;
	baseHash: string | null;
	savedAt: number;
}

export interface DraftStore {
	get(key: DraftKey): Promise<Draft | null>;
	put(key: DraftKey, draft: Draft): Promise<void>;
	remove(key: DraftKey): Promise<void>;
}

const DATABASE = "thinkrail-drafts";
const STORE = "drafts";

export function draftId({ host, workspaceId, path }: DraftKey): string {
	return tupleKey("draft", host, workspaceId, path);
}

function isDraft(value: unknown): value is Draft {
	if (typeof value !== "object" || value === null) return false;
	const text: unknown = Reflect.get(value, "text");
	const baseHash: unknown = Reflect.get(value, "baseHash");
	const savedAt: unknown = Reflect.get(value, "savedAt");
	return (
		typeof text === "string" &&
		(typeof baseHash === "string" || baseHash === null) &&
		typeof savedAt === "number"
	);
}

function settle<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

const NO_DRAFTS: DraftStore = {
	get: () => Promise.resolve(null),
	put: () => Promise.resolve(),
	remove: () => Promise.resolve(),
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
		remove: async (key) => {
			await run("readwrite", (store) => store.delete(draftId(key)));
		},
	};
}
