import { createHash } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { NativeDraft, NativeDraftKey } from "@thinkrail/contracts";

const MAX_DRAFT_TEXT_LENGTH = 4 * 1024 * 1024;
const MAX_DRAFT_FILE_BYTES = 4 * MAX_DRAFT_TEXT_LENGTH;
const MAX_ID_LENGTH = 4096;
const DRAFT_SUFFIX = ".json";

function isId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

export function readDraftKey(value: unknown): NativeDraftKey | null {
	if (typeof value !== "object" || value === null) return null;
	const workspaceId: unknown = Reflect.get(value, "workspaceId");
	const path: unknown = Reflect.get(value, "path");
	return isId(workspaceId) && isId(path) ? { workspaceId, path } : null;
}

export function readDraft(value: unknown): NativeDraft | null {
	const key = readDraftKey(value);
	if (!key || typeof value !== "object" || value === null) return null;
	const text: unknown = Reflect.get(value, "text");
	const baseHash: unknown = Reflect.get(value, "baseHash");
	const owner: unknown = Reflect.get(value, "owner");
	if (typeof text !== "string" || text.length > MAX_DRAFT_TEXT_LENGTH) return null;
	if (baseHash !== null && !isId(baseHash)) return null;
	if (!isId(owner)) return null;
	return { ...key, text, baseHash, owner };
}

function fileName({ workspaceId, path }: NativeDraftKey): string {
	const digest = createHash("sha256")
		.update(JSON.stringify([workspaceId, path]))
		.digest("hex");
	return `${digest}${DRAFT_SUFFIX}`;
}

function readFile(file: string): NativeDraft | null {
	try {
		if (statSync(file).size > MAX_DRAFT_FILE_BYTES) return null;
		return readDraft(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return null;
	}
}

/** One file per draft under `dir`, named by a hash of its key, so drafts outlive the window origin. */
export function createDraftStore(dir: string, onError: (error: unknown) => void) {
	const guard = <T>(fallback: T, run: () => T): T => {
		try {
			return run();
		} catch (error) {
			onError(error);
			return fallback;
		}
	};
	const sameKey = (draft: NativeDraft, key: NativeDraftKey) =>
		draft.workspaceId === key.workspaceId && draft.path === key.path;

	return {
		get: (key: NativeDraftKey): NativeDraft | null => {
			const draft = readFile(join(dir, fileName(key)));
			return draft && sameKey(draft, key) ? draft : null;
		},
		put: (draft: NativeDraft): void =>
			guard(undefined, () => {
				mkdirSync(dir, { recursive: true });
				const file = join(dir, fileName(draft));
				const temporary = `${file}.${process.pid}.tmp`;
				writeFileSync(temporary, JSON.stringify(draft));
				renameSync(temporary, file);
			}),
		remove: (key: NativeDraftKey & { owner: string }): void =>
			guard(undefined, () => {
				const file = join(dir, fileName(key));
				const draft = readFile(file);
				if (draft && sameKey(draft, key) && draft.owner === key.owner)
					rmSync(file, { force: true });
			}),
		removeWorkspace: ({ workspaceId }: Omit<NativeDraftKey, "path">): void =>
			guard(undefined, () => {
				let names: string[];
				try {
					names = readdirSync(dir);
				} catch {
					return;
				}
				for (const name of names) {
					if (!name.endsWith(DRAFT_SUFFIX)) continue;
					const file = join(dir, name);
					if (readFile(file)?.workspaceId === workspaceId) rmSync(file, { force: true });
				}
			}),
	};
}
