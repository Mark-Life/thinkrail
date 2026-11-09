import type {
	Ack,
	AnyHostWelcome,
	ProjectId,
	SessionId,
	SessionStateRecord,
	Workspace,
	WorkspaceId,
	WsMethodName,
	WsParams,
	WsResult,
} from "@thinkrail/contracts";
import { protocolMismatch, WS_CHANNELS, welcomeFailure } from "@thinkrail/contracts";
import { currentLocale } from "@thinkrail/locales/react";
import { isConnectedGeneration, useAppStore } from "../store";
import { githubStarToast } from "./githubStar";
import { createPiEventBatcher, shouldFlushPiEventsBefore } from "./piEventBatcher";
import { WsTransport } from "./transport";

let transport: WsTransport | null = null;

export function respondToTool(
	sessionId: SessionId,
	toolCallId: string,
	response: unknown,
): Promise<void> {
	return getTransport()
		.request("session.respondToTool", { sessionId, toolCallId, response })
		.then(() => undefined);
}

export function runHostUpdate(): Promise<Ack> {
	return getTransport().request("host.update", {});
}

interface SessionStateHydration {
	generation: number;
	installed: boolean;
	buffered: SessionStateRecord[];
}

let sessionStateHydration: SessionStateHydration | null = null;
const SESSION_STATE_BUFFER_LIMIT = 4_096;

export function mergeSessionStateRecords(
	snapshot: readonly SessionStateRecord[],
	buffered: readonly SessionStateRecord[],
): SessionStateRecord[] {
	const latestBySession = new Map(snapshot.map((record) => [record.sessionId, record]));
	for (const record of buffered) latestBySession.set(record.sessionId, record);
	return [...latestBySession.values()];
}

function applySessionStateRecord(record: SessionStateRecord): void {
	const store = useAppStore.getState();
	store.applySessionState(record);
	if (record.state.needsInput?.kind === "dialog") {
		store.applyExtUi(record.state.needsInput.request);
	}
}

function hydrateSessionStates(connectionGeneration: number): void {
	const hydration: SessionStateHydration = {
		generation: connectionGeneration,
		installed: false,
		buffered: [],
	};
	sessionStateHydration = hydration;
	let retryDelay = 500;
	const attempt = (): void => {
		void getTransport()
			.request("session.stateList", {})
			.then((records) => {
				const current = useAppStore.getState();
				if (
					sessionStateHydration !== hydration ||
					!isConnectedGeneration(current, connectionGeneration)
				) {
					return;
				}
				const ordered = mergeSessionStateRecords(records, hydration.buffered);
				current.installSessionStateSnapshot(ordered);
				for (const record of ordered) {
					if (record.state.needsInput?.kind === "dialog") {
						current.applyExtUi(record.state.needsInput.request);
					}
				}
				hydration.installed = true;
				hydration.buffered = [];
			})
			.catch(() => {
				const current = useAppStore.getState();
				if (
					sessionStateHydration !== hydration ||
					!isConnectedGeneration(current, connectionGeneration)
				) {
					return;
				}
				setTimeout(attempt, retryDelay);
				retryDelay = Math.min(retryDelay * 2, 8_000);
			});
	};
	attempt();
}

type FolderSnapshotMethod = "locales.list" | "themes.list" | "fonts.list";

function refreshFolderSnapshot<M extends FolderSnapshotMethod>(
	method: M,
	params: WsParams<M>,
	install: (store: ReturnType<typeof useAppStore.getState>, snapshot: WsResult<M> | null) => void,
	connectionGeneration: number,
): void {
	const store = useAppStore.getState();
	if (store.protocolVersion === null) {
		install(store, null);
		return;
	}
	void getTransport()
		.request(method, params)
		.then((snapshot) => {
			const current = useAppStore.getState();
			if (isConnectedGeneration(current, connectionGeneration)) install(current, snapshot);
		})
		.catch(() => {});
}

function refreshLocalLocales(connectionGeneration: number): void {
	refreshFolderSnapshot(
		"locales.list",
		{},
		(store, snapshot) => store.installLocalLocales(snapshot),
		connectionGeneration,
	);
}

function refreshUserThemes(connectionGeneration: number): void {
	refreshFolderSnapshot(
		"themes.list",
		{},
		(store, snapshot) => store.installUserThemes(snapshot),
		connectionGeneration,
	);
}

function refreshUserFonts(connectionGeneration: number): void {
	refreshFolderSnapshot(
		"fonts.list",
		{},
		(store, snapshot) => store.installUserFonts(snapshot),
		connectionGeneration,
	);
}

function refreshLoadedWorkspaceLists(connectionGeneration: number): void {
	const snapshot = useAppStore.getState();
	const openProjectIds = new Set(snapshot.projects.map((project) => project.id));
	for (const projectId of openProjectIds) {
		const held = snapshot.workspaces[projectId];
		if (!held) continue;
		const heldAtRequest = held.map((workspace) => workspace.id);
		void getTransport()
			.request("workspace.list", { projectId, includeDiffStats: false })
			.then((workspaces) => {
				const current = useAppStore.getState();
				if (!isConnectedGeneration(current, connectionGeneration)) return;
				applyWorkspaceListRefresh(projectId, heldAtRequest, workspaces);
			})
			.catch(() => {});
	}
}

export function applyWorkspaceListRefresh(
	projectId: ProjectId,
	heldAtRequest: readonly WorkspaceId[],
	workspaces: readonly Workspace[],
): void {
	const store = useAppStore.getState();
	if (!store.projects.some((project) => project.id === projectId)) return;
	for (const workspace of workspaces) store.updateWorkspace(workspace);
	const listed = new Set(workspaces.map((workspace) => workspace.id));
	for (const workspaceId of heldAtRequest) {
		if (listed.has(workspaceId)) continue;
		const held = useAppStore.getState().workspaces[projectId];
		if (held?.some((workspace) => workspace.id === workspaceId)) {
			retireWorkspace(projectId, workspaceId);
		}
	}
}

export function retireWorkspace(projectId: ProjectId, workspaceId: WorkspaceId): void {
	const state = useAppStore.getState();
	const login = state.activeLogin;
	state.applyWorkspaceRemoved(projectId, workspaceId);
	if (login?.target?.workspaceId === workspaceId) {
		void getTransport()
			.request("provider.loginCancel", { loginId: login.loginId })
			.catch(() => {});
	}
}

async function loadWorkspaceCreations(connectionGeneration: number): Promise<void> {
	const creations = await getTransport().request("workspace.listCreations", {});
	const before = useAppStore.getState();
	if (!isConnectedGeneration(before, connectionGeneration)) return;
	const watched = before.activeCreationId
		? before.workspaceCreations[before.activeCreationId]
		: undefined;
	before.setWorkspaceCreations(creations);
	if (!watched || creations.some((creation) => creation.id === watched.id)) return;
	const rows = await getTransport().request("workspace.list", {
		projectId: watched.projectId,
		includeDiffStats: false,
	});
	const current = useAppStore.getState();
	if (!isConnectedGeneration(current, connectionGeneration)) return;
	current.setWorkspaces(watched.projectId, rows);
	current.landOnFinishedCreation(watched.projectId, watched.id);
}

function refreshWorkspaceCreations(connectionGeneration: number): void {
	void loadWorkspaceCreations(connectionGeneration).catch(() => {});
}

export function initTransport(onInvalidReply?: (method: WsMethodName) => void): WsTransport {
	if (transport) return transport;
	const piEvents = createPiEventBatcher((payloads) =>
		useAppStore.getState().handlePiEvents(payloads),
	);

	transport = new WsTransport(
		{
			onStatus: (status) => {
				piEvents.flush();
				useAppStore.getState().setStatus(status);
			},
		},
		{
			beforeDispatch: (message) => {
				if (shouldFlushPiEventsBefore(message)) piEvents.flush();
			},
			...(onInvalidReply ? { onInvalidReply } : {}),
		},
	);

	transport.subscribe(WS_CHANNELS.serverWelcome, (data) => {
		const welcome: AnyHostWelcome = data;
		useAppStore.getState().hideSurveyInvitation();
		const mismatch = protocolMismatch(welcome);
		useAppStore.getState().setProtocolMismatch(mismatch);
		if (mismatch) {
			console.warn(`refused the host's welcome as ${mismatch}:`, welcomeFailure(welcome));
			return;
		}
		useAppStore
			.getState()
			.installWelcomeSnapshot(
				welcome.protocolVersion,
				welcome.projects,
				welcome.recentProjects ?? welcome.projects,
				welcome.config,
				welcome.hostPlatform === "darwin" ||
					welcome.hostPlatform === "linux" ||
					welcome.hostPlatform === "win32"
					? welcome.hostPlatform
					: undefined,
				welcome.hostUpdate,
				welcome.appVersion,
				welcome.speech,
			);
		useAppStore.getState().syncConfigReadNotice(welcome.configReadFailed === true);
		const connectionGeneration = useAppStore.getState().connectionGeneration;
		refreshLoadedWorkspaceLists(connectionGeneration);
		refreshLocalLocales(connectionGeneration);
		refreshUserThemes(connectionGeneration);
		refreshUserFonts(connectionGeneration);
		refreshWorkspaceCreations(connectionGeneration);
		hydrateSessionStates(connectionGeneration);
		void loadInAppSurvey();
	});

	transport.subscribe(WS_CHANNELS.hostUpdateAvailable, (data) => {
		useAppStore.getState().applyHostUpdate(data);
	});

	transport.subscribe(WS_CHANNELS.projectUpdated, (data) => {
		useAppStore.getState().applyProjectUpdated(data);
	});

	transport.subscribe(WS_CHANNELS.piEvent, (data) => {
		piEvents.enqueue(data);
	});

	transport.subscribe(WS_CHANNELS.piExtensionUi, (data) => {
		useAppStore.getState().applyExtUi(data);
	});

	transport.subscribe(WS_CHANNELS.sessionCreated, (summary) => {
		useAppStore.getState().noteClosedChats(summary.workspaceId, [
			{
				sessionId: summary.sessionId,
				title: summary.title,
				...(summary.firstPrompt ? { firstPrompt: summary.firstPrompt } : {}),
				closedAt: summary.updatedAt,
			},
		]);
	});

	transport.subscribe(WS_CHANNELS.sessionDeleted, ({ workspaceId, sessionId }) => {
		useAppStore.getState().deleteChat(workspaceId, sessionId, false);
	});

	transport.subscribe(WS_CHANNELS.sessionState, (record) => {
		const hydration = sessionStateHydration;
		const current = useAppStore.getState();
		if (hydration && hydration.generation !== current.connectionGeneration) return;
		if (hydration && !hydration.installed && isConnectedGeneration(current, hydration.generation)) {
			if (hydration.buffered.length >= SESSION_STATE_BUFFER_LIMIT) {
				hydrateSessionStates(hydration.generation);
				sessionStateHydration?.buffered.push(record);
			} else {
				hydration.buffered.push(record);
			}
			return;
		}
		applySessionStateRecord(record);
	});

	transport.subscribe(WS_CHANNELS.providerLogin, (push) => {
		const state = useAppStore.getState();
		if (push.target && state.removedWorkspaceIds[push.target.workspaceId]) {
			void getTransport()
				.request("provider.loginCancel", { loginId: push.loginId })
				.catch(() => {});
			return;
		}
		state.applyLoginFrame(push);
	});

	transport.subscribe(WS_CHANNELS.mcpStatus, (data) => {
		useAppStore.getState().applyMcpStatus(data);
	});

	transport.subscribe(WS_CHANNELS.providerChanged, () => {
		useAppStore.getState().noteProviderChanged();
		const providerVersion = useAppStore.getState().providerVersion;
		getTransport()
			.request("model.list", {})
			.then((models) => useAppStore.getState().setModelsForProviderVersion(providerVersion, models))
			.catch(() => {});
	});

	transport.subscribe(WS_CHANNELS.localesChanged, () => {
		refreshLocalLocales(useAppStore.getState().connectionGeneration);
	});

	transport.subscribe(WS_CHANNELS.themesChanged, () => {
		refreshUserThemes(useAppStore.getState().connectionGeneration);
	});

	transport.subscribe(WS_CHANNELS.packagesChanged, () => {
		useAppStore.getState().bumpPackagesVersion();
	});

	transport.subscribe(WS_CHANNELS.fontsChanged, () => {
		refreshUserFonts(useAppStore.getState().connectionGeneration);
	});

	transport.subscribe(WS_CHANNELS.speechChanged, (data) => {
		useAppStore.getState().installSpeechStatus(data);
	});

	transport.subscribe(WS_CHANNELS.feedbackInterview, () => {
		const state = useAppStore.getState();
		if (state.protocolVersion === null) return;
		state.showSurveyInvitation();
	});

	transport.subscribe(WS_CHANNELS.feedbackGithubStar, (data) => {
		useAppStore.getState().pushToast(githubStarToast(data));
	});

	transport.subscribe(WS_CHANNELS.workspaceCreated, (data) => {
		const store = useAppStore.getState();
		store.addWorkspace(data);
		if (store.protocolVersion !== null && store.status === "connected") {
			hydrateSessionStates(store.connectionGeneration);
		}
	});

	transport.subscribe(WS_CHANNELS.workspaceCreationChanged, (data) => {
		useAppStore.getState().applyWorkspaceCreation(data);
	});

	transport.subscribe(WS_CHANNELS.workspaceCreationRemoved, (data) => {
		useAppStore.getState().applyWorkspaceCreationRemoved(data);
	});

	transport.subscribe(WS_CHANNELS.workspaceUpdated, (data) => {
		useAppStore.getState().updateWorkspace(data);
	});

	transport.subscribe(WS_CHANNELS.workspaceRemoved, ({ projectId, id }) => {
		retireWorkspace(projectId, id);
	});

	transport.subscribe(WS_CHANNELS.reviewChanged, (data) => {
		useAppStore.getState().applyReviewChanged(data);
	});

	transport.subscribe(WS_CHANNELS.workspaceFsChanged, (data) => {
		useAppStore.getState().noteFsChanged(data);
	});

	transport.subscribe(WS_CHANNELS.turnChanged, (data) => {
		useAppStore.getState().applyTurnChanged(data);
	});

	transport.subscribe(WS_CHANNELS.settingsChanged, (data) => {
		useAppStore.getState().applyConfig(data);
		useAppStore.getState().syncConfigReadNotice(false);
	});

	transport.connect();
	return transport;
}

export function getTransport(): WsTransport {
	if (!transport) throw new Error("transport not initialized — call initTransport() first");
	return transport;
}

let surveyLoadGeneration = 0;

export function loadInAppSurvey(): Promise<void> {
	if (useAppStore.getState().protocolVersion === null) {
		useAppStore.getState().setInAppSurvey(null);
		return Promise.resolve();
	}
	const generation = ++surveyLoadGeneration;
	return getTransport()
		.request("feedback.survey", { language: currentLocale() })
		.then((result) => {
			if (generation !== surveyLoadGeneration) return;
			useAppStore.getState().setInAppSurvey(result.survey);
		})
		.catch(() => {});
}

export function forgetInAppSurvey(): void {
	surveyLoadGeneration += 1;
	useAppStore.getState().setInAppSurvey(null);
}
