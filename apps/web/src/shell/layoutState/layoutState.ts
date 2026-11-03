import { compile, int, map, obj, opt, str } from "@earendil-works/pi-schema";
import type { LayoutPreset, WorkspaceId } from "@thinkrail/contracts";
import { t } from "@thinkrail/locales/react";
import { useEffect, useLayoutEffect } from "react";
import { getStablePreferenceAdapter, type StablePreferenceAdapter } from "../../clientPreferences";
import { type LayoutAttention, randomId, sameLayoutAttention } from "../../lib";
import {
	DEFAULT_LOCAL_LAYOUT_PREFERENCES,
	type LocalLayoutPreferences,
	type LocalLayoutStatePayload,
	toast,
	useAppStore,
} from "../../store";
import { errorText, getTransport } from "../../transport";
import {
	adoptToolSelections,
	applyProjectedLayoutDocument,
	applyWorkbenchPreset,
	BUILTIN_LAYOUT_PRESETS,
	changedToolSelections,
	DEFAULT_LAYOUT_PRESET_ID,
	emptyWorkspaceView,
	ensureWorkbenchToolPlacementIds,
	instantiateWorkbenchFrame,
	minimumBottomGroupLimit,
	minimumSideGroupLimit,
	normalizeWorkspaceView,
	projectWorkspaceLayout,
	reconcileAttention,
	sameWorkbenchFrameShape,
	validateLayoutDocument,
	type WorkbenchFrame,
	type WorkspaceLayoutDocument,
	type WorkspaceViewState,
} from "../layout";
import { parseStoredFrame, parseStoredView } from "./storedLayout";

const LOCAL_LAYOUT_VERSION = 1;
const SURFACE_ID_KEY = "thinkrail:layout-surface-id";
const NATIVE_LAYOUT_PREFERENCE_KEY = "workbench-layout";
const NATIVE_LAYOUT_MAX_CHARACTERS = 256 * 1024;

interface PersistedLocalLayout {
	version: 1;
	frame: WorkbenchFrame;
	viewsByWorkspace: Record<string, WorkspaceViewState>;
	attentionByWorkspace: Record<string, LayoutAttention>;
	preferences: LocalLayoutPreferences;
}

interface StoragePair {
	local: Storage;
	session: Storage;
}

let storageOverride: StoragePair | null = null;
let endpointOverride: string | null = null;
let stablePreferenceOverride: StablePreferenceAdapter | null | undefined;
let persistenceKey: string | null = null;
let activeStablePreferences: StablePreferenceAdapter | null = null;
let stopPersistence: (() => void) | null = null;
let releaseSurfaceLease: (() => void) | null = null;
let initialization: Promise<void> | null = null;
const workspaceInitializations = new Map<string, Promise<WorkspaceLayoutDocument>>();

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stores(): StoragePair | null {
	if (storageOverride) return storageOverride;
	if (typeof localStorage === "undefined" || typeof sessionStorage === "undefined") return null;
	return { local: localStorage, session: sessionStorage };
}

export async function claimLayoutSurfaceId(
	storage: Storage,
	claim: (id: string) => Promise<boolean>,
): Promise<string> {
	let id = storage.getItem(SURFACE_ID_KEY) || randomId("surface");
	while (!(await claim(id))) id = randomId("surface");
	storage.setItem(SURFACE_ID_KEY, id);
	return id;
}

function acquireWebLock(name: string): Promise<(() => void) | null | undefined> {
	if (typeof navigator === "undefined" || !navigator.locks) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		let reported = false;
		void navigator.locks
			.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
				reported = true;
				if (!lock) {
					resolve(null);
					return;
				}
				let release: (() => void) | undefined;
				const held = new Promise<void>((done) => {
					release = done;
				});
				resolve(() => release?.());
				await held;
			})
			.catch(() => {
				if (!reported) resolve(undefined);
			});
	});
}

function acquireBroadcastLease(
	endpoint: string,
	id: string,
): Promise<(() => void) | null | undefined> {
	if (typeof BroadcastChannel === "undefined") return Promise.resolve(undefined);
	const channel = new BroadcastChannel(`thinkrail:layout-surfaces:${endpoint}`);
	const token = randomId("surface-claim");
	let occupied = false;
	return new Promise((resolve) => {
		channel.onmessage = (event: MessageEvent<unknown>) => {
			if (!isRecord(event.data) || event.data.id !== id) return;
			if (event.data.type === "probe" && event.data.token !== token) {
				occupied = true;
				channel.postMessage({ type: "occupied", id, token: event.data.token });
				return;
			}
			if (event.data.type === "occupied" && event.data.token === token) occupied = true;
		};
		channel.postMessage({ type: "probe", id, token });
		setTimeout(() => {
			if (occupied) {
				channel.close();
				resolve(null);
				return;
			}
			channel.onmessage = (event: MessageEvent<unknown>) => {
				if (
					isRecord(event.data) &&
					event.data.type === "probe" &&
					event.data.id === id &&
					typeof event.data.token === "string"
				) {
					channel.postMessage({ type: "occupied", id, token: event.data.token });
				}
			};
			resolve(() => channel.close());
		}, 60);
	});
}

function retainSurfaceLease(release: () => void): void {
	let active = true;
	const releaseOnce = () => {
		if (!active) return;
		active = false;
		window.removeEventListener("pagehide", onPageHide);
		release();
		if (releaseSurfaceLease === releaseOnce) releaseSurfaceLease = null;
	};
	const onPageHide = (event: PageTransitionEvent) => {
		if (!event.persisted) releaseOnce();
	};
	releaseSurfaceLease = releaseOnce;
	window.addEventListener("pagehide", onPageHide);
}

async function resolveSurfaceId(storage: StoragePair, endpoint: string): Promise<string> {
	if (storageOverride) return claimLayoutSurfaceId(storage.session, async () => true);
	const pendingLease: { release?: () => void } = {};
	try {
		const id = await claimLayoutSurfaceId(storage.session, async (candidate) => {
			const name = `thinkrail:layout-surface:${JSON.stringify([endpoint, candidate])}`;
			const webLock = await acquireWebLock(name);
			if (webLock === null) return false;
			const lease = webLock ?? (await acquireBroadcastLease(endpoint, candidate));
			if (lease === null) return false;
			if (lease) pendingLease.release = lease;
			return true;
		});
		if (pendingLease.release && typeof window !== "undefined") {
			retainSurfaceLease(pendingLease.release);
		}
		return id;
	} catch (error) {
		pendingLease.release?.();
		throw error;
	}
}

export function localLayoutStorageKey(endpoint: string, id: string): string {
	return `thinkrail:workbench:${JSON.stringify([endpoint, id])}`;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const keys = new Set(allowed);
	return Object.keys(value).every((key) => keys.has(key));
}

const SideGroupId = opt(str());
const StoredAttention = compile(
	obj(
		{
			selectedByGroup: map(str()),
			lastFocusedCenterGroupId: str(),
			lastFocusedSideGroupId: obj({ left: SideGroupId, right: SideGroupId, bottom: SideGroupId }),
			navigationClockByGroup: map(int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
		},
		{ open: true },
	),
);

function parseAttention(value: unknown): LayoutAttention | undefined {
	if (!StoredAttention.check(value)) return undefined;
	return {
		selectedByGroup: { ...value.selectedByGroup },
		lastFocusedCenterGroupId: value.lastFocusedCenterGroupId,
		lastFocusedSideGroupId: { ...value.lastFocusedSideGroupId },
		navigationClockByGroup: { ...value.navigationClockByGroup },
	};
}

function frameGroupIds(frame: WorkbenchFrame): Set<string> {
	const ids = new Set<string>();
	const visitCenter = (node: WorkbenchFrame["center"]): void => {
		if (node.kind === "group") {
			ids.add(node.id);
			return;
		}
		visitCenter(node.children[0]);
		visitCenter(node.children[1]);
	};
	visitCenter(frame.center);
	for (const region of [frame.left, frame.right, frame.bottom]) {
		for (const group of region.groups) ids.add(group.id);
	}
	return ids;
}

function parsePreferences(value: unknown): LocalLayoutPreferences | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.defaultPresetId !== "string" ||
		!Number.isInteger(value.maxSideGroups) ||
		Number(value.maxSideGroups) < 1 ||
		Number(value.maxSideGroups) > 32 ||
		!Number.isInteger(value.maxBottomGroups) ||
		Number(value.maxBottomGroups) < 1 ||
		Number(value.maxBottomGroups) > 32
	) {
		return undefined;
	}
	return {
		defaultPresetId: value.defaultPresetId,
		maxSideGroups: Number(value.maxSideGroups),
		maxBottomGroups: Number(value.maxBottomGroups),
	};
}

function decodeLocalLayout(raw: string): LocalLayoutStatePayload | undefined {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			!isRecord(parsed) ||
			parsed.version !== LOCAL_LAYOUT_VERSION ||
			!hasOnlyKeys(parsed, [
				"version",
				"frame",
				"viewsByWorkspace",
				"attentionByWorkspace",
				"preferences",
			])
		) {
			return undefined;
		}
		const frame = parseStoredFrame(parsed.frame);
		if (!frame) return undefined;
		if (!isRecord(parsed.viewsByWorkspace) || !isRecord(parsed.attentionByWorkspace)) {
			return undefined;
		}
		const preferences = parsePreferences(parsed.preferences);
		if (!preferences) return undefined;
		const validGroupIds = frameGroupIds(frame);
		const viewsByWorkspace: Record<string, WorkspaceViewState> = {};
		const documentsByWorkspace: Record<string, WorkspaceLayoutDocument> = {};
		const attentionByWorkspace: Record<string, LayoutAttention> = {};
		for (const [workspaceId, stored] of Object.entries(parsed.viewsByWorkspace)) {
			const view = parseStoredView(stored);
			if (!view || Object.keys(view.groups).some((id) => !validGroupIds.has(id))) {
				return undefined;
			}
			const normalized = normalizeWorkspaceView(frame, view);
			viewsByWorkspace[workspaceId] = normalized;
			const document = projectWorkspaceLayout(frame, normalized);
			if (validateLayoutDocument(document, 32, 32).length > 0) return undefined;
			documentsByWorkspace[workspaceId] = document;
			attentionByWorkspace[workspaceId] = reconcileAttention(
				document,
				parseAttention(parsed.attentionByWorkspace[workspaceId]),
			);
		}
		if (Object.keys(documentsByWorkspace).length === 0) {
			const frameDocument = emptyWorkspaceProjection(frame).document;
			if (validateLayoutDocument(frameDocument, 32, 32).length > 0) return undefined;
		}
		return {
			frame,
			viewsByWorkspace,
			documentsByWorkspace,
			attentionByWorkspace,
			preferences,
		};
	} catch {
		return undefined;
	}
}

function encodeLocalLayout(state: ReturnType<typeof useAppStore.getState>): string | null {
	if (!state.layoutStateReady || !state.workbenchFrame) return null;
	const value: PersistedLocalLayout = {
		version: LOCAL_LAYOUT_VERSION,
		frame: state.workbenchFrame,
		viewsByWorkspace: state.workspaceViewsByWorkspace,
		attentionByWorkspace: state.layoutAttentionByWorkspace,
		preferences: state.localLayoutPreferences,
	};
	return JSON.stringify(value);
}

function persistCurrentLayout(): void {
	const encoded = encodeLocalLayout(useAppStore.getState());
	if (!encoded) return;
	try {
		if (activeStablePreferences) {
			if (encoded.length > NATIVE_LAYOUT_MAX_CHARACTERS) {
				throw new Error(t("workbench.layoutState.tooLargeForNative"));
			}
			activeStablePreferences.setItem(NATIVE_LAYOUT_PREFERENCE_KEY, encoded);
			return;
		}
		const storage = stores();
		if (!storage || !persistenceKey) return;
		storage.local.setItem(persistenceKey, encoded);
	} catch (error) {
		toast.error(errorText(error), t("workbench.layoutState.saveFailed"));
	}
}

function startPersistence(): void {
	if (stopPersistence) return;
	stopPersistence = useAppStore.subscribe((state, previous) => {
		if (
			state.workbenchFrame === previous.workbenchFrame &&
			state.workspaceViewsByWorkspace === previous.workspaceViewsByWorkspace &&
			state.layoutAttentionByWorkspace === previous.layoutAttentionByWorkspace &&
			state.localLayoutPreferences === previous.localLayoutPreferences &&
			state.layoutStateReady === previous.layoutStateReady
		) {
			return;
		}
		persistCurrentLayout();
	});
}

async function loadPersistedLayout(): Promise<LocalLayoutStatePayload | undefined> {
	activeStablePreferences =
		stablePreferenceOverride === undefined
			? getStablePreferenceAdapter()
			: stablePreferenceOverride;
	if (activeStablePreferences) {
		persistenceKey = null;
		try {
			const raw = activeStablePreferences.getItem(NATIVE_LAYOUT_PREFERENCE_KEY);
			return raw ? decodeLocalLayout(raw) : undefined;
		} catch {
			return undefined;
		}
	}
	const storage = stores();
	if (!storage) return undefined;
	try {
		const endpoint = endpointOverride ?? getTransport().httpBase();
		const id = await resolveSurfaceId(storage, endpoint);
		persistenceKey = localLayoutStorageKey(endpoint, id);
		const raw = storage.local.getItem(persistenceKey);
		return raw ? decodeLocalLayout(raw) : undefined;
	} catch {
		persistenceKey = null;
		return undefined;
	}
}

function balancedFrame(): WorkbenchFrame {
	const preset = BUILTIN_LAYOUT_PRESETS.find(
		(candidate) => candidate.id === DEFAULT_LAYOUT_PRESET_ID,
	);
	if (!preset) throw new Error("The Balanced layout preset is missing");
	return instantiateWorkbenchFrame(preset);
}

function documentsForViews(
	frame: WorkbenchFrame,
	views: Record<string, WorkspaceViewState>,
): Record<string, WorkspaceLayoutDocument> {
	return Object.fromEntries(
		Object.entries(views).map(([workspaceId, view]) => [
			workspaceId,
			projectWorkspaceLayout(frame, view),
		]),
	);
}

export function initializeLocalLayoutState(): Promise<void> {
	if (initialization) return initialization;
	const run = (async () => {
		const state = useAppStore.getState();
		if (!state.layoutStateReady) {
			const persisted = await loadPersistedLayout();
			if (persisted) {
				state.hydrateLocalLayoutState(persisted);
			} else {
				state.hydrateLocalLayoutState({
					frame: balancedFrame(),
					viewsByWorkspace: {},
					documentsByWorkspace: {},
					attentionByWorkspace: {},
					preferences: { ...DEFAULT_LOCAL_LAYOUT_PREFERENCES },
				});
			}
		}
		startPersistence();
	})();
	initialization = run.catch((error) => {
		initialization = null;
		throw error;
	});
	return initialization;
}

export function emptyWorkspaceProjection(
	frame: WorkbenchFrame,
	reference?: { document: WorkspaceLayoutDocument; attention: LayoutAttention },
): {
	view: WorkspaceViewState;
	document: WorkspaceLayoutDocument;
	attention: LayoutAttention;
} {
	const view = emptyWorkspaceView();
	const document = projectWorkspaceLayout(frame, view);
	const reconciled = reconcileAttention(document, undefined);
	return {
		view,
		document,
		attention: reference
			? adoptToolSelections(reconciled, document, reference.attention, reference.document)
			: reconciled,
	};
}

export function workspaceProjectionReference(
	workspaceId: WorkspaceId,
): { document: WorkspaceLayoutDocument; attention: LayoutAttention } | undefined {
	const state = useAppStore.getState();
	for (const id of state.workspaceSelectionHistory) {
		if (id === workspaceId || state.removedWorkspaceIds[id]) continue;
		const document = state.layoutDocumentsByWorkspace[id];
		const attention = state.layoutAttentionByWorkspace[id];
		if (document && attention) return { document, attention };
	}
	return undefined;
}

function installWorkspaceView(workspaceId: WorkspaceId): WorkspaceLayoutDocument {
	const state = useAppStore.getState();
	if (state.removedWorkspaceIds[workspaceId]) throw new Error("Workspace has been removed");
	const existingDocument = state.layoutDocumentsByWorkspace[workspaceId];
	if (existingDocument) return existingDocument;
	if (!state.workbenchFrame) throw new Error("The local workbench frame is not ready");
	const projection = emptyWorkspaceProjection(
		state.workbenchFrame,
		workspaceProjectionReference(workspaceId),
	);
	state.applyLocalLayoutState({
		frame: state.workbenchFrame,
		viewsByWorkspace: { ...state.workspaceViewsByWorkspace, [workspaceId]: projection.view },
		documentsByWorkspace: {
			...state.layoutDocumentsByWorkspace,
			[workspaceId]: projection.document,
		},
		attentionByWorkspace: {
			...state.layoutAttentionByWorkspace,
			[workspaceId]: projection.attention,
		},
		preferences: state.localLayoutPreferences,
	});
	const installed = useAppStore.getState().layoutDocumentsByWorkspace[workspaceId];
	if (!installed) throw new Error("The workspace layout could not be initialized");
	return installed;
}

export function ensureWorkspaceLayoutState(
	workspaceId: WorkspaceId,
): Promise<WorkspaceLayoutDocument> {
	const existing = workspaceInitializations.get(workspaceId);
	if (existing) return existing;
	const request = (async () => {
		if (useAppStore.getState().removedWorkspaceIds[workspaceId]) {
			throw new Error("Workspace has been removed");
		}
		await initializeLocalLayoutState();
		return installWorkspaceView(workspaceId);
	})().finally(() => {
		if (workspaceInitializations.get(workspaceId) === request) {
			workspaceInitializations.delete(workspaceId);
		}
	});
	workspaceInitializations.set(workspaceId, request);
	return request;
}

export function applyLayoutPresetLocally(preset: LayoutPreset): void {
	const state = useAppStore.getState();
	if (!state.workbenchFrame) throw new Error("The local workbench frame is not ready");
	const next = applyWorkbenchPreset(
		{ frame: state.workbenchFrame, viewsByWorkspace: state.workspaceViewsByWorkspace },
		preset,
	);
	const documentsByWorkspace = documentsForViews(next.frame, next.viewsByWorkspace);
	const attentionByWorkspace: Record<string, LayoutAttention> = {};
	for (const [workspaceId, document] of Object.entries(documentsByWorkspace)) {
		attentionByWorkspace[workspaceId] = reconcileAttention(
			document,
			state.layoutAttentionByWorkspace[workspaceId],
			state.layoutDocumentsByWorkspace[workspaceId],
		);
	}
	state.applyLocalLayoutState(
		{
			frame: next.frame,
			viewsByWorkspace: next.viewsByWorkspace,
			documentsByWorkspace,
			attentionByWorkspace,
			preferences: {
				...state.localLayoutPreferences,
				maxSideGroups: Math.max(
					state.localLayoutPreferences.maxSideGroups,
					minimumSideGroupLimit(preset),
				),
				maxBottomGroups: Math.max(
					state.localLayoutPreferences.maxBottomGroups,
					minimumBottomGroupLimit(preset),
				),
			},
		},
		true,
	);
}

function rebaseProjectedDocument(
	base: WorkspaceLayoutDocument,
	next: WorkspaceLayoutDocument,
	current: WorkspaceLayoutDocument,
): WorkspaceLayoutDocument {
	if (current === base) return next;
	return {
		version: 2,
		center: next.center === base.center ? current.center : next.center,
		left: next.left === base.left ? current.left : next.left,
		right: next.right === base.right ? current.right : next.right,
		bottom: next.bottom === base.bottom ? current.bottom : next.bottom,
		toolRestoreTargets:
			next.toolRestoreTargets === base.toolRestoreTargets
				? current.toolRestoreTargets
				: next.toolRestoreTargets,
	};
}

export function applyLayoutAttention(workspaceId: WorkspaceId, next: LayoutAttention): void {
	const state = useAppStore.getState();
	if (state.removedWorkspaceIds[workspaceId]) return;
	const document = state.layoutDocumentsByWorkspace[workspaceId];
	const normalized = document ? reconcileAttention(document, next, document) : next;
	if (sameLayoutAttention(state.layoutAttentionByWorkspace[workspaceId], normalized)) return;
	const groups = document
		? changedToolSelections(state.layoutAttentionByWorkspace[workspaceId], normalized, document)
		: new Set<string>();
	if (!document || groups.size === 0 || !state.workbenchFrame) {
		state.setLayoutAttention(workspaceId, normalized);
		return;
	}
	const attentionByWorkspace = {
		...state.layoutAttentionByWorkspace,
		[workspaceId]: normalized,
	};
	for (const [id, attention] of Object.entries(state.layoutAttentionByWorkspace)) {
		if (id === workspaceId || state.removedWorkspaceIds[id]) continue;
		const otherDocument = state.layoutDocumentsByWorkspace[id];
		if (!otherDocument) continue;
		attentionByWorkspace[id] = adoptToolSelections(
			attention,
			otherDocument,
			normalized,
			document,
			groups,
		);
	}
	state.applyLocalLayoutState({
		frame: state.workbenchFrame,
		viewsByWorkspace: state.workspaceViewsByWorkspace,
		documentsByWorkspace: state.layoutDocumentsByWorkspace,
		attentionByWorkspace,
		preferences: state.localLayoutPreferences,
	});
}

export interface LayoutCommitOptions {
	baseDocument?: WorkspaceLayoutDocument;
	attention?: LayoutAttention;
}

export async function commitWorkspaceLayout(
	workspaceId: WorkspaceId,
	document: WorkspaceLayoutDocument,
	options: LayoutCommitOptions = {},
): Promise<WorkspaceLayoutDocument> {
	const { baseDocument } = options;
	const state = useAppStore.getState();
	if (state.removedWorkspaceIds[workspaceId]) throw new Error("Workspace has been removed");
	if (!state.workbenchFrame) throw new Error("The local workbench frame is not ready");
	const currentDocument = state.layoutDocumentsByWorkspace[workspaceId];
	const effectiveDocument =
		baseDocument && currentDocument
			? rebaseProjectedDocument(baseDocument, document, currentDocument)
			: document;
	const validationErrors = validateLayoutDocument(effectiveDocument, 32, 32);
	if (validationErrors.length > 0) throw new Error(validationErrors.join(" "));
	const projected = applyProjectedLayoutDocument(
		{ frame: state.workbenchFrame, viewsByWorkspace: state.workspaceViewsByWorkspace },
		workspaceId,
		effectiveDocument,
	);
	const frame = ensureWorkbenchToolPlacementIds(projected.frame, projected.viewsByWorkspace);
	const frameChanged = frame !== state.workbenchFrame;
	const documentsByWorkspace = frameChanged
		? documentsForViews(frame, projected.viewsByWorkspace)
		: { ...state.layoutDocumentsByWorkspace, [workspaceId]: effectiveDocument };
	const changedWorkspaceIds = frameChanged ? Object.keys(documentsByWorkspace) : [workspaceId];
	const attentionByWorkspace = { ...state.layoutAttentionByWorkspace };
	for (const id of changedWorkspaceIds) {
		const nextDocument = documentsByWorkspace[id];
		if (!nextDocument) continue;
		attentionByWorkspace[id] = reconcileAttention(
			nextDocument,
			id === workspaceId
				? (options.attention ?? state.layoutAttentionByWorkspace[id])
				: state.layoutAttentionByWorkspace[id],
			id === workspaceId && options.attention
				? effectiveDocument
				: state.layoutDocumentsByWorkspace[id],
		);
	}
	const committingAttention = attentionByWorkspace[workspaceId];
	const committingDocument = documentsByWorkspace[workspaceId];
	if (!committingAttention || !committingDocument)
		throw new Error("The committed workspace projection is missing");
	const toolChanges = changedToolSelections(
		state.layoutAttentionByWorkspace[workspaceId],
		committingAttention,
		committingDocument,
	);
	if (frameChanged || toolChanges.size > 0) {
		if (committingAttention && committingDocument) {
			for (const [id, attention] of Object.entries(attentionByWorkspace)) {
				if (id === workspaceId) continue;
				const otherDocument = documentsByWorkspace[id];
				if (!otherDocument || state.removedWorkspaceIds[id]) continue;
				attentionByWorkspace[id] = adoptToolSelections(
					attention,
					otherDocument,
					committingAttention,
					committingDocument,
					frameChanged ? undefined : toolChanges,
				);
			}
		}
	}
	state.applyLocalLayoutState(
		{
			frame,
			viewsByWorkspace: projected.viewsByWorkspace,
			documentsByWorkspace,
			attentionByWorkspace,
			preferences: state.localLayoutPreferences,
		},
		frameChanged && !sameWorkbenchFrameShape(frame, state.workbenchFrame),
	);
	return useAppStore.getState().layoutDocumentsByWorkspace[workspaceId] ?? document;
}

export function useLocalLayoutState(): void {
	useEffect(() => {
		void initializeLocalLayoutState().catch((error) => {
			toast.error(errorText(error), t("workbench.layoutState.loadFailed"));
		});
	}, []);
}

export function useWorkspaceLayoutState(workspaceId: WorkspaceId): void {
	useLayoutEffect(() => {
		const report = (error: unknown) => {
			if (!useAppStore.getState().removedWorkspaceIds[workspaceId]) {
				toast.error(errorText(error), t("workbench.layoutState.loadFailed"));
			}
		};
		if (useAppStore.getState().layoutStateReady) {
			try {
				installWorkspaceView(workspaceId);
			} catch (error) {
				report(error);
			}
			return;
		}
		void ensureWorkspaceLayoutState(workspaceId).catch(report);
	}, [workspaceId]);
}

export function setLayoutStateStorageForTests(
	storage: StoragePair | null,
	endpoint: string | null = null,
): void {
	storageOverride = storage;
	endpointOverride = endpoint;
	stablePreferenceOverride = null;
}

export function setLayoutStateStablePreferencesForTests(
	preferences: StablePreferenceAdapter | null,
): void {
	stablePreferenceOverride = preferences;
}

export function resetLayoutStateForTests(): void {
	workspaceInitializations.clear();
	stopPersistence?.();
	stopPersistence = null;
	releaseSurfaceLease?.();
	releaseSurfaceLease = null;
	initialization = null;
	persistenceKey = null;
	activeStablePreferences = null;
	storageOverride = null;
	endpointOverride = null;
	stablePreferenceOverride = undefined;
}
