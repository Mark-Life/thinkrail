import { randomId, tupleKey } from "../lib";

export interface DraftKey {
	host: string;
	workspaceId: string;
	path: string;
}

export interface Draft {
	text: string;
	baseHash: string | null;
	/** The page that wrote it; a draft whose page is still open is not restored elsewhere. */
	owner: string;
}

export interface DraftStore {
	get(key: DraftKey): Promise<Draft | null>;
	put(key: DraftKey, draft: Draft): Promise<void>;
	/** Deletes the record only while `owner` still wrote it. */
	remove(key: DraftKey, owner: string): Promise<void>;
}

export interface DraftOwner {
	id: string;
	isAlive(owner: string): Promise<boolean>;
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
	const owner: unknown = Reflect.get(value, "owner");
	return (
		typeof text === "string" &&
		(typeof baseHash === "string" || baseHash === null) &&
		typeof owner === "string"
	);
}

function settle<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

const OWNER_LOCK = "thinkrail-draft-owner:";

/** One id per page load, held as a Web Lock so other pages can tell whether it is still open. */
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
	};
}
