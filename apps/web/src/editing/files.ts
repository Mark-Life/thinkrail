import { FILE_WRITE_MAX_BYTES, type ResourceMeta } from "@thinkrail/contracts";
import { i18n } from "@thinkrail/locales/react";
import type { ResourceRenderer } from "@thinkrail/resource-renderers";
import { fileName } from "../lib";
import { toast, useAppStore } from "../store";
import { getTransport, supportsFileWrite } from "../transport";
import { isEditableMeta } from "./buffer";
import { indexedDbDrafts } from "./drafts";
import { type BufferRegistry, createBufferRegistry, type FileIo, fileBufferKey } from "./registry";

const DRAFT_DELAY_MS = 300;

const io: FileIo = {
	read: (workspaceId, path) => getTransport().request("fs.readFile", { workspaceId, path }),
	write: (params) => getTransport().request("fs.writeFile", params),
	exists: async (workspaceId, path) => {
		const slash = path.lastIndexOf("/");
		const dir = slash < 0 ? "." : path.slice(0, slash);
		try {
			const nodes = await getTransport().request("fs.readDir", { workspaceId, path: dir });
			return nodes.some((node) => node.path === path);
		} catch {
			return false;
		}
	},
};

function writable(protocolVersion: number | null): boolean {
	return protocolVersion === null || supportsFileWrite(protocolVersion);
}

type AppState = ReturnType<typeof useAppStore.getState>;

function openFileKeys(state: AppState): Set<string> {
	const keys = new Set<string>();
	for (const [workspaceId, tabs] of Object.entries(state.tabsByWorkspace)) {
		for (const tab of tabs) if (tab.kind === "file") keys.add(fileBufferKey(workspaceId, tab.path));
	}
	return keys;
}

let registry: BufferRegistry | null = null;

export function bufferRegistry(): BufferRegistry {
	if (registry) return registry;
	const created = createBufferRegistry({
		io,
		drafts: indexedDbDrafts(),
		publish: (workspaceId, path, summary) =>
			useAppStore.getState().setFileBufferSummary(workspaceId, path, summary),
		hostKey: () => getTransport().httpBase(),
		canWrite: () => writable(useAppStore.getState().protocolVersion),
		onDraftRestored: (path) =>
			toast.info(i18n.t("editing.draftRestored", { name: fileName(path) })),
		draftDelayMs: DRAFT_DELAY_MS,
		now: () => Date.now(),
	});
	useAppStore.subscribe((state, previous) => {
		if (state.tabsByWorkspace !== previous.tabsByWorkspace) created.prune(openFileKeys(state));
		if (state.connectionGeneration !== previous.connectionGeneration) {
			void created.reconcileAll();
		}
	});
	globalThis.addEventListener?.("pagehide", () => created.flushDrafts());
	globalThis.document?.addEventListener("visibilitychange", () => {
		if (globalThis.document.visibilityState === "hidden") created.flushDrafts();
	});
	registry = created;
	return created;
}

export function canEditFile({
	mobile,
	renderer,
	meta,
	protocolVersion,
	buffered,
}: {
	mobile: boolean;
	renderer: Pick<ResourceRenderer, "capabilities">;
	meta: ResourceMeta | undefined;
	protocolVersion: number | null;
	buffered: boolean;
}): boolean {
	if (mobile || renderer.capabilities.edit !== true || !meta || !isEditableMeta(meta)) return false;
	if (meta.byteLength !== null && meta.byteLength > FILE_WRITE_MAX_BYTES) return false;
	return protocolVersion === null ? buffered : supportsFileWrite(protocolVersion);
}

export function isFileDirty(workspaceId: string, path: string): boolean {
	return registry?.isDirty(fileBufferKey(workspaceId, path)) ?? false;
}

export function saveFile(workspaceId: string, path: string) {
	return bufferRegistry().save(fileBufferKey(workspaceId, path));
}

export function discardFile(workspaceId: string, path: string): void {
	registry?.discard(fileBufferKey(workspaceId, path));
}

function activeFileKey(state: AppState): string | null {
	const workspaceId = state.activeWorkspaceId;
	if (!workspaceId) return null;
	const activeId = state.activeTabByWorkspace[workspaceId];
	const tab = state.tabsByWorkspace[workspaceId]?.find((candidate) => candidate.id === activeId);
	return tab?.kind === "file" ? fileBufferKey(workspaceId, tab.path) : null;
}

export function saveFocusedFile(): void {
	if (!registry) return;
	const focused = globalThis.document?.activeElement
		?.closest("[data-file-buffer]")
		?.getAttribute("data-file-buffer");
	const key = focused ?? activeFileKey(useAppStore.getState());
	if (key) void registry.save(key);
}
