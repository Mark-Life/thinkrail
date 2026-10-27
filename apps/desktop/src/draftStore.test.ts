import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftStore, readDraft } from "./draftStore";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function draftDir(): string {
	const root = mkdtempSync(join(tmpdir(), "thinkrail-drafts-"));
	roots.push(root);
	return join(root, "drafts");
}

const draft = { workspaceId: "w1", path: "src/a.ts", text: "mine\n", baseHash: "h:1", owner: "p1" };

test("a draft written by one launch loads in the next", () => {
	const dir = draftDir();
	createDraftStore(dir, () => {}).put(draft);
	const next = createDraftStore(dir, () => {});
	expect(next.get({ workspaceId: "w1", path: "src/a.ts" })).toEqual(draft);
	expect(next.get({ workspaceId: "w1", path: "src/b.ts" })).toBeNull();
});

test("remove deletes only the caller's own draft", () => {
	const store = createDraftStore(draftDir(), () => {});
	store.put(draft);
	store.remove({ workspaceId: "w1", path: "src/a.ts", owner: "p2" });
	expect(store.get(draft)).toEqual(draft);
	store.remove({ workspaceId: "w1", path: "src/a.ts", owner: "p1" });
	expect(store.get(draft)).toBeNull();
});

test("removeWorkspace deletes every draft of that workspace and keeps others", () => {
	const dir = draftDir();
	const store = createDraftStore(dir, () => {});
	store.put(draft);
	store.put({ ...draft, path: "src/b.ts" });
	store.put({ ...draft, workspaceId: "w2" });
	store.removeWorkspace({ workspaceId: "w1" });
	expect(readdirSync(dir)).toHaveLength(1);
	expect(store.get({ workspaceId: "w2", path: "src/a.ts" })).not.toBeNull();
});

test("a missing folder reads as no drafts and an unwritable one reports the error", () => {
	const errors: unknown[] = [];
	const dir = draftDir();
	const store = createDraftStore(join(dir, "\0bad"), (error) => errors.push(error));
	expect(store.get(draft)).toBeNull();
	store.removeWorkspace({ workspaceId: "w1" });
	store.put(draft);
	expect(errors).toHaveLength(1);
});

test("readDraft rejects payloads that are not drafts", () => {
	expect(readDraft(draft)).toEqual(draft);
	expect(readDraft({ ...draft, baseHash: null })).toEqual({ ...draft, baseHash: null });
	expect(readDraft({ ...draft, text: 1 })).toBeNull();
	expect(readDraft({ ...draft, owner: "" })).toBeNull();
	expect(readDraft({ ...draft, path: undefined })).toBeNull();
	expect(readDraft(null)).toBeNull();
});
