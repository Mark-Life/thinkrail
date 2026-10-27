import { FILE_WRITE_MAX_BYTES, type FileContent, type ResourceMeta } from "@thinkrail/contracts";
import { i18n } from "@thinkrail/locales/react";
import type { ResourceRenderer } from "@thinkrail/resource-renderers";
import { fileName } from "../lib";
import { selectActiveEditorTab, selectWorkspaceTick, toast, useAppStore } from "../store";
import { getTransport, supportsFileWrite } from "../transport";
import { isEditableMeta } from "./buffer";
import { indexedDbDrafts, nativeDrafts, nativeEditingBridge, pageDraftOwner } from "./drafts";
import { type BufferRegistry, createBufferRegistry, type FileIo, fileBufferKey } from "./registry";

const DRAFT_DELAY_MS = 300;

export function syncFileTabs(workspaceId: string, path: string, file: FileContent, tick: number) {
	const state = useAppStore.getState();
	for (const tab of state.tabsByWorkspace[workspaceId] ?? []) {
		if (tab.kind === "file" && tab.path === path && (tab.loadedTick ?? 0) <= tick) {
			state.updateFileTabContent(workspaceId, tab.id, file.content, file.meta, tick);
		}
	}
}

const io: FileIo = {
	read: (workspaceId, path) => {
		const tick = selectWorkspaceTick(useAppStore.getState(), workspaceId);
		return getTransport()
			.request("fs.readFile", { workspaceId, path })
			.then((file) => {
				syncFileTabs(workspaceId, path, file, tick);
				return file;
			});
	},
	write: (params) => getTransport().request("fs.writeFile", params),
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

/** Whether any file holds edits that will not reach disk unless the user saves. */
export function hasUnsavedEdits(state: Pick<AppState, "fileBuffersByWorkspace">): boolean {
	return Object.values(state.fileBuffersByWorkspace).some((summaries) =>
		Object.values(summaries).some((summary) => summary.dirty),
	);
}

let registry: BufferRegistry | null = null;

export function bufferRegistry(): BufferRegistry {
	if (registry) return registry;
	const native = nativeEditingBridge();
	const created = createBufferRegistry({
		io,
		drafts: native ? nativeDrafts(native) : indexedDbDrafts(),
		draftOwner: pageDraftOwner(),
		publish: (workspaceId, path, summary) =>
			useAppStore.getState().setFileBufferSummary(workspaceId, path, summary),
		hostKey: () => getTransport().httpBase(),
		canWrite: () => writable(useAppStore.getState().protocolVersion),
		isConnected: () => useAppStore.getState().status === "connected",
		onDraftRestored: (path) =>
			toast.info(i18n.t("editing.draftRestored", { name: fileName(path) })),
		draftDelayMs: DRAFT_DELAY_MS,
	});
	let unsaved = false;
	useAppStore.subscribe((state, previous) => {
		if (native && state.fileBuffersByWorkspace !== previous.fileBuffersByWorkspace) {
			const next = hasUnsavedEdits(state);
			if (next !== unsaved) native.setUnsavedEdits(next);
			unsaved = next;
		}
		if (state.removedWorkspaceIds !== previous.removedWorkspaceIds) {
			for (const workspaceId of Object.keys(state.removedWorkspaceIds)) {
				if (!previous.removedWorkspaceIds[workspaceId]) created.forgetWorkspace(workspaceId);
			}
		}
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

export function saveFile(workspaceId: string, path: string) {
	return bufferRegistry().save(fileBufferKey(workspaceId, path));
}

export function discardFile(workspaceId: string, path: string): void {
	registry?.discard(fileBufferKey(workspaceId, path));
}

function activeFileKey(state: AppState): string | null {
	const workspaceId = state.activeWorkspaceId;
	if (!workspaceId) return null;
	const tab = selectActiveEditorTab(state, workspaceId);
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
