import { createHash, randomUUID } from "node:crypto";
import { join, normalize } from "node:path";
import type {
	HostPlatform,
	HostUpdateNotice,
	ServerWelcome,
	SessionDeletedPayload,
	SessionStateRecord,
	SessionSummary,
	TerminalTabsPush,
	WorkspaceFsChangedPayload,
} from "@thinkrail/contracts";
import {
	FEEDBACK_SURVEY_PROTOCOL_VERSION,
	FONTS_PROTOCOL_VERSION,
	GITHUB_STAR_PROTOCOL_VERSION,
	LOCALES_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION,
	PI_PACKAGES_PROTOCOL_VERSION,
	PROTOCOL_VERSION,
	SPEECH_PROTOCOL_VERSION,
	SPEECH_SOCKET_ROUTE,
	USER_FONTS_ROUTE,
	USER_THEMES_PROTOCOL_VERSION,
	WORKSPACE_CREATION_PROTOCOL_VERSION,
	WS_CHANNELS,
} from "@thinkrail/contracts";
import { CodedError, errorCodeOf } from "@thinkrail/shared/codedError";
import {
	admissionContextFor,
	bumpPackageSwitchGeneration,
	cancelAllMcpProbes,
	cancelMcpProbesOwnedBy,
	disposeAllSessions,
	getSessionWorkspaceId,
	handlePiSettingsFileChanged,
	handleProjectPiSettingsChanged,
	initializeSessionStates,
	isProjectSkillPath,
	liveSessionIdsOf,
	mcpPolicyOf,
	piTrustsProjectPath,
	primeProjectPiSettings,
	primeUserPiSettings,
	publishPiPackagesChanged,
	reconcileMcpSessions,
	refreshAgentReviewTool,
	refreshExtensionTools,
	refreshSubagentConcurrency,
	refreshSubagentTools,
	setAgentReviewEnabledResolver,
	setDisabledExtensionsResolver,
	setDisabledPackagesResolver,
	setExtensionSettingsResolver,
	setExtUiPublisher,
	setMcpLoginPublisher,
	setMcpPolicyResolver,
	setMcpStatusPublisher,
	setMcpToolGrantWriter,
	setModelListingPublisher,
	setModelsFilePublisher,
	setPiPackagesPublisher,
	setRequestReviewHandler,
	setReviewCommentHandler,
	setSessionCreatedPublisher,
	setSessionDeletedPublisher,
	setSessionProjectResolver,
	setSessionPublisher,
	setSessionResourcesPublisher,
	setSessionStatePublisher,
	setSkillAdmissionResolver,
	setSubagentConcurrencyResolver,
	setSubagentsEnabledResolver,
	setTitleToolHost,
	settleSessionsForShutdown,
	watchUserMcpConfig,
} from "../agent";
import {
	type AnalyticsOptions,
	initializeAnalytics,
	reportError,
	shutdownAnalytics,
	startAttributionClaim,
	surveyEndpoint,
	track,
} from "../analytics";
import {
	cancelAllLogins,
	initializeJbcentralRuntime,
	setJbcentralAppliedPublisher,
	setJbcentralChangedPublisher,
	setLoginPublisher,
	setLogoutPublisher,
	stopJbcentralRuntime,
} from "../auth";
import { forgetOpenBranchReview } from "../branch-review";
import {
	configureSurveySource,
	redeliverInvitation,
	refreshInAppSurvey,
	releaseInvitation,
	setFeedbackPublisher,
	setGithubStarPublisher,
} from "../feedback";
import { watchUserFonts } from "../fonts";
import { watchLocalLocales } from "../locales";
import { logger, observeLoggedErrors } from "../log";
import { loadWorkspaces } from "../persistence";
import {
	getProjects,
	grantProjectMcpTool,
	listProjects,
	listRecentProjects,
	openProject,
	refreshRecentProjectFolders,
	setPiTrustSeed,
	setProjectPathGuard,
	setProjectPublisher,
} from "../projects";
import { reanchorWorkspace, resolveCommentFromAgent, setReviewPublisher } from "../reviews";
import { configReadFailed, getConfig, setSettingsPublisher } from "../settings";
import {
	createSpeechRelay,
	initSpeech,
	type SpeechRelay,
	setSpeechPublisher,
	speechStatus,
	stopEngine,
	stopSpeechInstall,
} from "../speech";
import {
	clearTerminalClient,
	closeAllTerminals,
	persistTerminalSessions,
	resumeClientTerminals,
	reviveTerminalSessions,
	setTerminalPublisher,
	setTerminalTabsPublisher,
} from "../terminal";
import { watchUserThemes } from "../themes";
import { isTodoToolEnd, maybeAttachChangeArtifacts } from "../todos";
import { setTurnPublisher, TurnTracker } from "../turns";
import {
	setRepoMetaPublisher,
	setSkillPathClassifier,
	setWatchPublisher,
	setWatchStartedPublisher,
	stopAllWatches,
} from "../watch";
import {
	creationOwnsPath,
	getWorkspace,
	interruptWorkspaceCreations,
	listAllWorkspaceRecords,
	recordWorkspaceHead,
	replayPendingHandoffs,
	seedWorkspaceHead,
	setWorkspaceCreationHandoff,
	setWorkspaceCreationPublisher,
	setWorkspacePublisher,
	stopWorkspaceCreations,
	syncWorkspaceBranch,
} from "../workspaces";
import { readClientFrame } from "./clientFrames";
import { BLOB_PREFIX, FILES_PREFIX, serveBlob, serveWorktreeFile } from "./fileRoutes";
import { serveUserFonts } from "./fontRoutes";
import { setFsNudgePublisher } from "./fsNudge";
import {
	handleRequest,
	reportsRequestFailure,
	requestErrorReport,
	requestMethodDiagnostic,
	workspaceCreationHandoff,
} from "./handlers";
import { provisionInitialTerminal } from "./initialTerminal";
import { trackLoginOutcome } from "./loginAnalytics";
import {
	additionalCapture,
	applyAdditionalAnalyticsSettings,
	captureReviewCommentResolved,
	initialAdditionalAnalyticsEnabled,
	observeCurrentSetup,
	setupObservation,
} from "./productAnalytics";
import {
	AbandonmentReportBudget,
	heaviestReplayMethod,
	type ReplayLoad,
	RequestAbandonedError,
	RequestReplayCache,
	RequestReplayOverflowError,
} from "./requestReplayCache";
import {
	installRequestReviewSeam,
	maybeAutoReReview,
	setReviewFailedPublisher,
} from "./requestReview";
import { runObservation } from "./runAnalytics";
import { hostSearch } from "./search";
import {
	REVIEW_REFRESH_INTERVAL_MS,
	refreshOpenProjectReviews,
	stampSessionActivity,
} from "./settledLifecycle";
import { resolveSubagentMaxConcurrent, resolveSubagentsEnabled } from "./subagentPolicy";
import { taskObservation } from "./taskAnalytics";
import {
	BACKPRESSURE_RECONCILE_MS,
	drainedClientKeys,
	terminalDeliveryForSendStatus,
} from "./terminalSend";
import { titleToolHost } from "./titleTool";
import { markClientStale, reconcilePendingReviewsOnBoot } from "./todoReview";
import { pushFrame } from "./wsResults";

export interface CreateServerOptions {
	port?: number;
	host?: string;
	staticDir?: string;
	projectPath?: string;
	appVersion?: string;
	analytics?: Pick<
		AnalyticsOptions,
		| "channel"
		| "build"
		| "posthogApiKey"
		| "posthogHost"
		| "appRoot"
		| "remapBase"
		| "mute"
		| "env"
		| "fetchImpl"
		| "openExternal"
		| "attributionEndpoint"
		| "attributionFetch"
		| "attributionSleep"
		| "attributionSchedule"
		| "attributionRequestTimeoutMs"
		| "attributionDeadlineMs"
	>;
	hostUpdate?: {
		intervalMs: number;
		check(): Promise<HostUpdateNotice | null>;
		run(): Promise<void>;
	};
}

export interface RunningServer {
	readonly port: number;
	startAttributionClaim: () => void;
	stop: () => void;
	shutdown: () => Promise<void>;
}

interface SocketData {
	clientKey: string;
	protocolVersion: number;
	/** Present only on a `/speech` socket, which bypasses the JSON request wire entirely. */
	speech?: SpeechRelay;
	speechSocket?: true;
}

const CLIENT_REPLAY_RETENTION_MS = 60_000;
const RECENT_FOLDER_CHECK_BUDGET_MS = 250;

const log = logger("host");

function requestFingerprint(method: string, params: unknown, sessionId: unknown): string {
	try {
		return createHash("sha256")
			.update(JSON.stringify([method, params, sessionId ?? null]))
			.digest("hex");
	} catch {
		throw new CodedError("INVALID_PARAMS", `Invalid ${method}`);
	}
}

function formatReplayLoad(load: ReplayLoad): string {
	const occupancy = ({ pending, settled, abandoned }: ReplayLoad[string]) =>
		pending + settled + abandoned;
	return Object.entries(load)
		.sort(([, a], [, b]) => occupancy(b) - occupancy(a))
		.map(
			([method, { pending, settled, abandoned }]) =>
				`${method} ${pending} pending/${settled} settled/${abandoned} abandoned`,
		)
		.join(", ");
}

function countMethods(methods: readonly string[]): string {
	const counts = new Map<string, number>();
	for (const method of methods) counts.set(method, (counts.get(method) ?? 0) + 1);
	return [...counts].map(([method, count]) => `${method} ×${count}`).join(", ");
}

function clientProtocolVersion(value: string | null): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function sameHostUpdateRelease(
	current: HostUpdateNotice | undefined,
	next: HostUpdateNotice,
): boolean {
	return (
		current !== undefined &&
		current.currentVersion === next.currentVersion &&
		current.availableVersion === next.availableVersion &&
		current.channel === next.channel
	);
}

export async function createServer(options: CreateServerOptions = {}): Promise<RunningServer> {
	await initializeJbcentralRuntime();
	getConfig();
	setPiTrustSeed(piTrustsProjectPath);
	const {
		port = 24242,
		host = "localhost",
		staticDir,
		projectPath,
		appVersion,
		analytics,
		hostUpdate,
	} = options;

	setSessionProjectResolver((workspaceId) => {
		try {
			return getWorkspace(workspaceId).projectId;
		} catch {
			return null;
		}
	});
	await initializeSessionStates(
		loadWorkspaces().map((workspace) => ({
			id: workspace.id,
			projectId: workspace.projectId,
			cwd: workspace.worktreePath,
		})),
	);

	const sockets = new Map<string, Bun.ServerWebSocket<SocketData>>();
	const reapTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const requestReplays = new RequestReplayCache<string>();
	const abandonmentReports = new AbandonmentReportBudget();
	const reportAbandoned = (methods: readonly string[]): void => {
		if (methods.length === 0) return;
		log.warn(`requests abandoned before their handlers settled: ${countMethods(methods)}`);
		for (const method of new Set(methods)) {
			if (abandonmentReports.admit(method))
				reportError(new RequestAbandonedError(), requestErrorReport(method));
		}
	};
	const terminalBackpressured = new Set<string>();
	let hostUpdateNotice: HostUpdateNotice | undefined;
	let hostUpdateTimer: ReturnType<typeof setInterval> | undefined;
	const reviewRefreshTimer = setInterval(
		() =>
			void refreshOpenProjectReviews().catch(() =>
				log.warn("periodic settled lifecycle refresh failed"),
			),
		REVIEW_REFRESH_INTERVAL_MS,
	);
	reviewRefreshTimer.unref?.();
	let hostUpdateActive = hostUpdate !== undefined;
	let hostUpdateChecking = false;
	let requestHostUpdate = (): void => {
		throw new Error("Host update is unavailable.");
	};
	let stopping = false;
	let shutdownPromise: Promise<void> | undefined;

	const armClientReap = (clientKey: string): void => {
		reapTimers.set(
			clientKey,
			setTimeout(() => {
				reapTimers.delete(clientKey);
				if (sockets.has(clientKey)) return;
				if (!requestReplays.clearClient(clientKey)) {
					armClientReap(clientKey);
					return;
				}
				clearTerminalClient(clientKey);
				releaseInvitation(clientKey);
				cancelMcpProbesOwnedBy(clientKey);
			}, CLIENT_REPLAY_RETENTION_MS),
		);
	};

	const server = Bun.serve<SocketData, never>({
		port,
		hostname: host,
		async fetch(req, srv) {
			const url = new URL(req.url);
			if (url.pathname === "/ws") {
				const clientKey = url.searchParams.get("client") ?? `anon-${randomUUID()}`;
				const protocolVersion = clientProtocolVersion(url.searchParams.get("protocol"));
				await refreshRecentProjectFolders(RECENT_FOLDER_CHECK_BUDGET_MS);
				return srv.upgrade(req, { data: { clientKey, protocolVersion } })
					? undefined
					: new Response("ws upgrade failed", { status: 400 });
			}
			if (url.pathname === SPEECH_SOCKET_ROUTE) {
				const protocolVersion = clientProtocolVersion(url.searchParams.get("protocol"));
				if (protocolVersion < SPEECH_PROTOCOL_VERSION) {
					return new Response("speech needs a newer client", { status: 400 });
				}
				const clientKey = url.searchParams.get("client") ?? `anon-${randomUUID()}`;
				return srv.upgrade(req, { data: { clientKey, protocolVersion, speechSocket: true } })
					? undefined
					: new Response("ws upgrade failed", { status: 400 });
			}
			if (url.pathname === "/health") {
				return new Response("ok");
			}
			if (url.pathname.startsWith(FILES_PREFIX)) {
				return serveWorktreeFile(url.pathname, url.searchParams.get("maxBytes"));
			}
			if (url.pathname.startsWith(BLOB_PREFIX)) {
				return serveBlob(url.pathname, req.signal);
			}
			if (url.pathname.startsWith(USER_FONTS_ROUTE)) {
				return serveUserFonts(req, url.pathname);
			}
			if (staticDir) {
				return serveStatic(url.pathname, staticDir);
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			open(ws) {
				if (ws.data.speechSocket) {
					ws.data.speech = createSpeechRelay(ws);
					return;
				}
				const replaced = sockets.get(ws.data.clientKey);
				sockets.set(ws.data.clientKey, ws);
				if (replaced && replaced !== ws) replaced.close();
				terminalBackpressured.delete(ws.data.clientKey);
				const pendingReap = reapTimers.get(ws.data.clientKey);
				if (pendingReap !== undefined) {
					clearTimeout(pendingReap);
					reapTimers.delete(ws.data.clientKey);
				}
				ws.subscribe(WS_CHANNELS.piEvent);
				ws.subscribe(WS_CHANNELS.piExtensionUi);
				ws.subscribe(WS_CHANNELS.sessionCreated);
				ws.subscribe(WS_CHANNELS.sessionDeleted);
				ws.subscribe(WS_CHANNELS.sessionResourcesChanged);
				ws.subscribe(WS_CHANNELS.sessionState);
				ws.subscribe(WS_CHANNELS.providerLogin);
				ws.subscribe(WS_CHANNELS.providerChanged);
				ws.subscribe(WS_CHANNELS.projectUpdated);
				ws.subscribe(WS_CHANNELS.terminalTabs);
				ws.subscribe(WS_CHANNELS.workspaceCreated);
				ws.subscribe(WS_CHANNELS.workspaceUpdated);
				ws.subscribe(WS_CHANNELS.workspaceRemoved);
				ws.subscribe(WS_CHANNELS.workspaceFsChanged);
				if (ws.data.protocolVersion >= WORKSPACE_CREATION_PROTOCOL_VERSION) {
					ws.subscribe(WS_CHANNELS.workspaceCreationChanged);
					ws.subscribe(WS_CHANNELS.workspaceCreationRemoved);
				}
				ws.subscribe(WS_CHANNELS.settingsChanged);
				if (hostUpdate) ws.subscribe(WS_CHANNELS.hostUpdateAvailable);
				ws.subscribe(WS_CHANNELS.reviewChanged);
				ws.subscribe(WS_CHANNELS.reviewFailed);
				ws.subscribe(WS_CHANNELS.turnChanged);
				if (ws.data.protocolVersion >= MCP_PROTOCOL_VERSION) ws.subscribe(WS_CHANNELS.mcpStatus);
				if (ws.data.protocolVersion >= LOCALES_PROTOCOL_VERSION)
					ws.subscribe(WS_CHANNELS.localesChanged);
				if (ws.data.protocolVersion >= USER_THEMES_PROTOCOL_VERSION)
					ws.subscribe(WS_CHANNELS.themesChanged);
				if (ws.data.protocolVersion >= PI_PACKAGES_PROTOCOL_VERSION)
					ws.subscribe(WS_CHANNELS.packagesChanged);
				if (ws.data.protocolVersion >= FONTS_PROTOCOL_VERSION)
					ws.subscribe(WS_CHANNELS.fontsChanged);
				const speech = ws.data.protocolVersion >= SPEECH_PROTOCOL_VERSION;
				if (speech) ws.subscribe(WS_CHANNELS.speechChanged);
				const hostPlatform: HostPlatform =
					process.platform === "darwin" || process.platform === "win32"
						? process.platform
						: "linux";
				const setupCapture = additionalCapture();
				const configUnreadable = configReadFailed();
				const welcome: ServerWelcome = {
					protocolVersion: PROTOCOL_VERSION,
					hostPlatform,
					projects: listProjects(),
					recentProjects: listRecentProjects(),
					config: getConfig(),
					...(speech ? { speech: speechStatus() } : {}),
					...(appVersion ? { appVersion } : {}),
					...(hostUpdateNotice ? { hostUpdate: hostUpdateNotice } : {}),
					...(configUnreadable ? { configReadFailed: true } : {}),
				};
				setupObservation.observe(setupCapture, {
					project_present: welcome.projects.length > 0 ? "yes" : "no",
				});
				const welcomeStatus = ws.send(pushFrame(WS_CHANNELS.serverWelcome, welcome));
				const welcomeDelivery = terminalDeliveryForSendStatus(welcomeStatus);
				if (welcomeDelivery === "unavailable") {
					ws.close();
					return;
				}
				if (welcomeDelivery === "backpressured") {
					terminalBackpressured.add(ws.data.clientKey);
				}
				resumeClientTerminals(ws.data.clientKey);
				redeliverInvitation(ws.data.clientKey);
			},
			async message(ws, message) {
				if (ws.data.speechSocket) {
					ws.data.speech?.message(message);
					return;
				}
				const raw = typeof message === "string" ? message : message.toString();
				const frame = readClientFrame(raw);
				if (frame.kind === "refused") return;
				if (frame.kind === "ack") {
					reportAbandoned(requestReplays.acknowledge(ws.data.clientKey, frame.ids));
					return;
				}
				if (frame.kind === "resume") {
					reportAbandoned(requestReplays.retain(ws.data.clientKey, frame.ids));
					return;
				}
				const { id: requestId, method, params, sessionId } = frame.request;
				const methodDiagnostic = requestMethodDiagnostic(method);
				log.debug(`ws ${methodDiagnostic}`);
				try {
					const response = await requestReplays.run(
						ws.data.clientKey,
						requestId,
						requestFingerprint(method, params, sessionId),
						async () => {
							try {
								const result = await handleRequest(method, params, {
									clientKey: ws.data.clientKey,
									protocolVersion: ws.data.protocolVersion,
									...(hostUpdate ? { runHostUpdate: requestHostUpdate } : {}),
								});
								return JSON.stringify({ id: requestId, ok: true, result });
							} catch (err) {
								const error = err instanceof Error ? err.message : String(err);
								log.debug(`ws ${methodDiagnostic} failed`);
								if (reportsRequestFailure(method)) reportError(err, requestErrorReport(method));
								const code = errorCodeOf(err);
								return JSON.stringify({
									id: requestId,
									ok: false,
									error,
									...(code ? { errorCode: code } : {}),
								});
							}
						},
						methodDiagnostic,
					);
					if (ws.send(response) === 0) ws.close();
				} catch (err) {
					const error = err instanceof Error ? err.message : String(err);
					if (err instanceof RequestReplayOverflowError && err.load) {
						log.warn(`replay namespace full; held requests: ${formatReplayLoad(err.load)}`);
						reportError(err, requestErrorReport(heaviestReplayMethod(err.load) ?? method));
					}
					const code = errorCodeOf(err);
					const reply = JSON.stringify({
						id: requestId,
						ok: false,
						error,
						...(code ? { errorCode: code } : {}),
					});
					if (ws.send(reply) === 0) ws.close();
				}
			},
			drain(ws) {
				if (ws.data.speechSocket) return;
				if (sockets.get(ws.data.clientKey) !== ws) return;
				terminalBackpressured.delete(ws.data.clientKey);
				resumeClientTerminals(ws.data.clientKey);
			},
			close(ws) {
				if (ws.data.speechSocket) {
					ws.data.speech?.close();
					return;
				}
				const { clientKey } = ws.data;
				if (stopping) return;
				if (sockets.get(clientKey) === ws) {
					sockets.delete(clientKey);
					terminalBackpressured.delete(clientKey);
				}
				if (sockets.has(clientKey) || reapTimers.has(clientKey)) return;
				armClientReap(clientKey);
			},
		},
	});

	const backpressureReconciler = setInterval(() => {
		const drained = drainedClientKeys(terminalBackpressured, (clientKey) =>
			sockets.get(clientKey)?.getBufferedAmount(),
		);
		for (const clientKey of drained) {
			log.warn(
				`terminal backpressure latch lifted by reconciler, drain never arrived (${clientKey})`,
			);
			terminalBackpressured.delete(clientKey);
			resumeClientTerminals(clientKey);
		}
	}, BACKPRESSURE_RECONCILE_MS);

	const publishHostUpdate = (notice: HostUpdateNotice): void => {
		if (!hostUpdateActive) return;
		hostUpdateNotice = notice;
		server.publish(
			WS_CHANNELS.hostUpdateAvailable,
			pushFrame(WS_CHANNELS.hostUpdateAvailable, notice),
		);
	};

	const clearHostUpdateTimer = (): void => {
		if (hostUpdateTimer !== undefined) clearInterval(hostUpdateTimer);
		hostUpdateTimer = undefined;
	};

	const hostUpdateBlocksDiscovery = (): boolean =>
		hostUpdateNotice?.status === "running" || hostUpdateNotice?.status === "succeeded";

	const checkForHostUpdate = async (): Promise<void> => {
		if (!hostUpdate || !hostUpdateActive || hostUpdateChecking || hostUpdateBlocksDiscovery()) {
			return;
		}
		hostUpdateChecking = true;
		try {
			const result = await hostUpdate.check();
			if (!hostUpdateActive || hostUpdateBlocksDiscovery()) return;
			if (result && !sameHostUpdateRelease(hostUpdateNotice, result)) {
				publishHostUpdate({
					currentVersion: result.currentVersion,
					availableVersion: result.availableVersion,
					channel: result.channel,
					status: "available",
				});
			}
		} catch {
		} finally {
			hostUpdateChecking = false;
		}
	};

	requestHostUpdate = (): void => {
		if (!hostUpdate || !hostUpdateActive || !hostUpdateNotice) {
			throw new Error("Host update is unavailable.");
		}
		if (hostUpdateNotice.status === "running" || hostUpdateNotice.status === "succeeded") {
			return;
		}
		publishHostUpdate({ ...hostUpdateNotice, status: "running" });
		void (async () => {
			try {
				await hostUpdate.run();
				if (!hostUpdateActive || hostUpdateNotice?.status !== "running") return;
				publishHostUpdate({ ...hostUpdateNotice, status: "succeeded" });
				clearHostUpdateTimer();
			} catch {
				if (!hostUpdateActive || hostUpdateNotice?.status !== "running") return;
				publishHostUpdate({ ...hostUpdateNotice, status: "failed" });
			}
		})();
	};

	const stopHostUpdateChecks = (): void => {
		hostUpdateActive = false;
		clearHostUpdateTimer();
	};

	setTerminalPublisher((clientKey, channel, data) => {
		if (terminalBackpressured.has(clientKey)) return "unavailable";
		const ws = sockets.get(clientKey);
		if (!ws) return "unavailable";
		try {
			const delivery = terminalDeliveryForSendStatus(ws.send(pushFrame(channel, data)));
			if (delivery !== "delivered") terminalBackpressured.add(clientKey);
			return delivery;
		} catch {
			terminalBackpressured.add(clientKey);
			ws.close();
			return "unavailable";
		}
	});

	setFeedbackPublisher((clientKey) => {
		const ws = sockets.get(clientKey);
		if (!ws || ws.data.protocolVersion < FEEDBACK_SURVEY_PROTOCOL_VERSION) return false;
		try {
			return ws.send(pushFrame(WS_CHANNELS.feedbackInterview, {})) !== 0;
		} catch {
			ws.close();
			return false;
		}
	});

	const githubStarSocket = (clientKey: string) => {
		const ws = sockets.get(clientKey);
		return ws && ws.data.protocolVersion >= GITHUB_STAR_PROTOCOL_VERSION ? ws : undefined;
	};
	setGithubStarPublisher({
		canAsk: (clientKey) => githubStarSocket(clientKey) !== undefined,
		ask: (clientKey, ask) => {
			const ws = githubStarSocket(clientKey);
			if (!ws) return false;
			try {
				return ws.send(pushFrame(WS_CHANNELS.feedbackGithubStar, ask)) !== 0;
			} catch {
				ws.close();
				return false;
			}
		},
	});

	setSkillAdmissionResolver((workspaceId) => {
		try {
			const { projectId, skillOverrides } = getWorkspace(workspaceId);
			const project = getProjects().find((p) => p.id === projectId);
			return admissionContextFor(project, skillOverrides ?? {});
		} catch {
			return admissionContextFor(undefined);
		}
	});

	setMcpPolicyResolver((workspaceId) => {
		try {
			const { projectId } = getWorkspace(workspaceId);
			return mcpPolicyOf(getProjects().find((p) => p.id === projectId));
		} catch {
			return mcpPolicyOf(undefined);
		}
	});
	setMcpToolGrantWriter((workspaceId, server, target, tool) => {
		grantProjectMcpTool(getWorkspace(workspaceId).projectId, server, target, tool);
	});

	setSubagentsEnabledResolver((workspaceId) => {
		try {
			return resolveSubagentsEnabled(getConfig().subagentsEnabled, getWorkspace(workspaceId));
		} catch {
			return false;
		}
	});

	setSubagentConcurrencyResolver((workspaceId) => {
		const globalDefault = getConfig().subagentMaxConcurrent;
		try {
			return resolveSubagentMaxConcurrent(globalDefault, getWorkspace(workspaceId));
		} catch {
			return resolveSubagentMaxConcurrent(globalDefault, undefined);
		}
	});

	setAgentReviewEnabledResolver(() => getConfig().agentReviewEnabled !== false);

	setDisabledExtensionsResolver(() => new Set(getConfig().disabledExtensions));
	setExtensionSettingsResolver(() => getConfig().extensionSettings ?? {});
	setDisabledPackagesResolver(() => new Set(getConfig().disabledPackages));

	setProjectPublisher((project) => {
		const capture = additionalCapture();
		if (capture) {
			try {
				setupObservation.observe(capture, {
					project_present: listProjects().length > 0 ? "yes" : "no",
				});
			} catch {}
		}
		server.publish(WS_CHANNELS.projectUpdated, pushFrame(WS_CHANNELS.projectUpdated, project));
	});

	setTerminalTabsPublisher((workspaceId, tabs) => {
		const data: TerminalTabsPush = { workspaceId, tabs };
		server.publish(WS_CHANNELS.terminalTabs, pushFrame(WS_CHANNELS.terminalTabs, data));
	});

	interruptWorkspaceCreations();
	setProjectPathGuard((path) => {
		if (creationOwnsPath(path))
			throw new Error("This folder belongs to a workspace ThinkRail is still creating");
	});
	setWorkspaceCreationHandoff(workspaceCreationHandoff);
	void replayPendingHandoffs().catch((err) => log.warn("replaying workspace handoffs failed", err));
	setWorkspaceCreationPublisher((event) => {
		if (event.kind === "changed") {
			server.publish(
				WS_CHANNELS.workspaceCreationChanged,
				pushFrame(WS_CHANNELS.workspaceCreationChanged, event.creation),
			);
			return;
		}
		server.publish(
			WS_CHANNELS.workspaceCreationRemoved,
			pushFrame(WS_CHANNELS.workspaceCreationRemoved, event.removed),
		);
	});

	setWorkspacePublisher((event) => {
		if (event.kind === "removed") {
			server.publish(
				WS_CHANNELS.workspaceRemoved,
				pushFrame(WS_CHANNELS.workspaceRemoved, { projectId: event.projectId, id: event.id }),
			);
			return;
		}
		const channel =
			event.kind === "created" ? WS_CHANNELS.workspaceCreated : WS_CHANNELS.workspaceUpdated;
		server.publish(channel, pushFrame(channel, event.workspace));
	});

	const publishFsChanged = (payload: WorkspaceFsChangedPayload) => {
		server.publish(
			WS_CHANNELS.workspaceFsChanged,
			pushFrame(WS_CHANNELS.workspaceFsChanged, payload),
		);
		reanchorWorkspace(payload.workspaceId);
		const changedRoot = loadWorkspaces().find((w) => w.id === payload.workspaceId)?.worktreePath;
		if (changedRoot) hostSearch().invalidateRoot(changedRoot);
		if (
			payload.truncated ||
			payload.paths.some((path) => path === ".pi" || path.startsWith(".pi/"))
		) {
			void reconcileMcpSessions(liveSessionIdsOf(payload.workspaceId));
		}
		if (
			payload.truncated ||
			payload.paths.some((path) => path === ".pi" || path === ".pi/settings.json")
		) {
			const workspace = listAllWorkspaceRecords().find((ws) => ws.id === payload.workspaceId);
			const trusted =
				workspace &&
				getProjects().find((project) => project.id === workspace.projectId)?.piResourceTrust ===
					"granted";
			if (workspace && trusted) handleProjectPiSettingsChanged(workspace.worktreePath);
		}
	};
	primeUserPiSettings();
	for (const workspace of listAllWorkspaceRecords()) primeProjectPiSettings(workspace.worktreePath);
	setPiPackagesPublisher(() =>
		server.publish(WS_CHANNELS.packagesChanged, pushFrame(WS_CHANNELS.packagesChanged, {})),
	);
	const stopUserMcpWatch = watchUserMcpConfig({ onSettingsChanged: handlePiSettingsFileChanged });
	const nudge = (channel: "locales.changed" | "themes.changed" | "fonts.changed") => () =>
		server.publish(channel, pushFrame(channel, {}));
	const stopLocalesWatch = watchLocalLocales({ onChange: nudge(WS_CHANNELS.localesChanged) });
	const stopThemesWatch = watchUserThemes({ onChange: nudge(WS_CHANNELS.themesChanged) });
	const stopFontsWatch = watchUserFonts({ onChange: nudge(WS_CHANNELS.fontsChanged) });
	setSpeechPublisher((status) =>
		server.publish(WS_CHANNELS.speechChanged, pushFrame(WS_CHANNELS.speechChanged, status)),
	);
	void initSpeech().catch((err) => log.warn("voice input state could not be read", err));
	setWatchPublisher(publishFsChanged);
	setSkillPathClassifier(isProjectSkillPath);
	setFsNudgePublisher(publishFsChanged);

	setWatchStartedPublisher(seedWorkspaceHead);
	setRepoMetaPublisher((workspaceId) => {
		recordWorkspaceHead(workspaceId);
		syncWorkspaceBranch(workspaceId);
		const workspace = loadWorkspaces().find((w) => w.id === workspaceId);
		if (workspace) forgetOpenBranchReview(workspace.worktreePath);
		publishFsChanged({ workspaceId, paths: [], truncated: false, skillChange: "none" });
	});

	setReviewPublisher((payload) => {
		server.publish(
			WS_CHANNELS.reviewChanged,
			pushFrame(WS_CHANNELS.reviewChanged, markClientStale(payload, payload.workspaceId)),
		);
	});
	setReviewFailedPublisher((payload) => {
		server.publish(WS_CHANNELS.reviewFailed, pushFrame(WS_CHANNELS.reviewFailed, payload));
	});
	setReviewCommentHandler((sessionId, commentId, note) => {
		const capture = additionalCapture();
		const resolved = resolveCommentFromAgent(sessionId, commentId, note);
		captureReviewCommentResolved(capture, "agent", "resolved");
		return { resolvedBody: resolved.body };
	});
	installRequestReviewSeam();
	setTitleToolHost(titleToolHost);
	reconcilePendingReviewsOnBoot();

	setSettingsPublisher((config, appliedUpdate) => {
		server.publish(WS_CHANNELS.settingsChanged, pushFrame(WS_CHANNELS.settingsChanged, config));
		if (applyAdditionalAnalyticsSettings(config, appliedUpdate)) {
			setupObservation.clear();
			runObservation.clear();
			taskObservation.clear();
			void observeCurrentSetup();
		}
		if (
			config.analyticsEnabled &&
			config.analyticsConsentConfirmed &&
			(appliedUpdate.analyticsEnabled === true || appliedUpdate.analyticsConsentConfirmed === true)
		) {
			startAttributionClaim();
		}
		if (appliedUpdate.subagentsEnabled !== undefined) refreshSubagentTools();
		if (appliedUpdate.subagentMaxConcurrent !== undefined) refreshSubagentConcurrency();
		if (appliedUpdate.agentReviewEnabled !== undefined) refreshAgentReviewTool();
		if (appliedUpdate.disabledPackages !== undefined) bumpPackageSwitchGeneration();
		if (
			appliedUpdate.disabledExtensions !== undefined ||
			appliedUpdate.extensionSettings !== undefined ||
			appliedUpdate.disabledPackages !== undefined
		) {
			refreshExtensionTools();
		}
		if (appliedUpdate.disabledPackages !== undefined) publishPiPackagesChanged();
	});

	setSessionCreatedPublisher((payload: SessionSummary) => {
		server.publish(WS_CHANNELS.sessionCreated, pushFrame(WS_CHANNELS.sessionCreated, payload));
	});

	setSessionStatePublisher((record: SessionStateRecord) => {
		stampSessionActivity(record);
		server.publish(WS_CHANNELS.sessionState, pushFrame(WS_CHANNELS.sessionState, record));
	});

	setSessionDeletedPublisher((payload: SessionDeletedPayload) => {
		runObservation.forget(payload.sessionId);
		taskObservation.forget(payload.sessionId);
		server.publish(WS_CHANNELS.sessionDeleted, pushFrame(WS_CHANNELS.sessionDeleted, payload));
	});

	setMcpLoginPublisher((push, ownerClientKey) => {
		const ws = sockets.get(ownerClientKey);
		if (!ws) return;
		try {
			ws.send(pushFrame(WS_CHANNELS.providerLogin, push));
		} catch {}
	});

	setMcpStatusPublisher((snapshot) => {
		server.publish(WS_CHANNELS.mcpStatus, pushFrame(WS_CHANNELS.mcpStatus, snapshot));
	});

	setSessionResourcesPublisher((payload) => {
		server.publish(
			WS_CHANNELS.sessionResourcesChanged,
			pushFrame(WS_CHANNELS.sessionResourcesChanged, payload),
		);
	});

	const turnTracker = new TurnTracker((sessionId) => {
		const workspaceId = getSessionWorkspaceId(sessionId);
		if (!workspaceId) return null;
		try {
			return { workspaceId, worktreePath: getWorkspace(workspaceId).worktreePath };
		} catch {
			return null;
		}
	});
	setTurnPublisher((turn) => {
		server.publish(WS_CHANNELS.turnChanged, pushFrame(WS_CHANNELS.turnChanged, turn));
	});
	setSessionPublisher((payload) => {
		runObservation.observe(payload.sessionId, payload.event);
		void turnTracker.observe(payload.sessionId, payload.event);
		if (payload.event.type === "tool_execution_start") {
			const workspaceId = getSessionWorkspaceId(payload.sessionId);
			if (workspaceId) taskObservation.toolStarted(workspaceId, payload.sessionId, payload.event);
		}
		server.publish(WS_CHANNELS.piEvent, pushFrame(WS_CHANNELS.piEvent, payload));
		if (isTodoToolEnd(payload.event)) {
			const workspaceId = getSessionWorkspaceId(payload.sessionId);
			const observeCompletion = taskObservation.toolFinished(payload.sessionId, payload.event);
			if (workspaceId)
				void maybeAttachChangeArtifacts(workspaceId, payload.sessionId).then(async () => {
					await observeCompletion();
					await maybeAutoReReview(workspaceId, payload.sessionId);
				});
		}
	});

	setExtUiPublisher((request, audience) => {
		const frame = pushFrame(WS_CHANNELS.piExtensionUi, request);
		if (!audience) {
			server.publish(WS_CHANNELS.piExtensionUi, frame);
			return;
		}
		for (const ws of sockets.values()) {
			if (ws.data.protocolVersion >= audience.belowProtocol) continue;
			try {
				ws.send(frame);
			} catch {}
		}
	});

	const publishProviderChanged = () => {
		server.publish(WS_CHANNELS.providerChanged, pushFrame(WS_CHANNELS.providerChanged, {}));
	};
	setLoginPublisher((push, generation) => {
		server.publish(WS_CHANNELS.providerLogin, pushFrame(WS_CHANNELS.providerLogin, push));
		if (push.frame.kind === "success" && !push.target) publishProviderChanged();
		trackLoginOutcome(push, generation);
	});
	setJbcentralAppliedPublisher(() => {
		track({
			name: "provider_login",
			params: { provider: "jbcentral", method: "central", auth_method: "central" },
		});
	});
	setJbcentralChangedPublisher(publishProviderChanged);
	setLogoutPublisher(publishProviderChanged);
	setModelsFilePublisher(publishProviderChanged);
	setModelListingPublisher(publishProviderChanged);

	const initialConfig = getConfig();
	initializeAnalytics({
		...(appVersion ? { appVersion } : {}),
		...(analytics ?? {}),
		additionalEnabled: initialAdditionalAnalyticsEnabled(initialConfig),
	});
	configureSurveySource(surveyEndpoint());
	void refreshInAppSurvey();
	observeLoggedErrors((scope, error) =>
		reportError(error, { source: "host_logged", handled: true, scope }),
	);
	reviveTerminalSessions();
	for (const workspace of loadWorkspaces()) provisionInitialTerminal(workspace);

	if (projectPath) {
		try {
			openProject(projectPath);
		} catch {
			log.warn("could not open requested project");
		}
	}

	void observeCurrentSetup();

	const stop = (): void => {
		if (stopping) return;
		stopping = true;
		clearInterval(reviewRefreshTimer);
		setupObservation.clear();
		runObservation.reset();
		taskObservation.clear();
		observeLoggedErrors(null);
		void shutdownAnalytics();
		stopHostUpdateChecks();
		cancelAllLogins();
		cancelAllMcpProbes();
		stopJbcentralRuntime();
		stopAllWatches();
		stopUserMcpWatch();
		stopLocalesWatch();
		stopThemesWatch();
		stopFontsWatch();
		stopSpeechInstall();
		void stopEngine();
		disposeAllSessions();
		for (const timer of reapTimers.values()) clearTimeout(timer);
		reapTimers.clear();
		sockets.clear();
		clearInterval(backpressureReconciler);
		terminalBackpressured.clear();
		requestReplays.clear();
		persistTerminalSessions();
		closeAllTerminals();
		restoreSeamDefaults();
		server.stop(true);
	};
	const shutdown = (): Promise<void> => {
		shutdownPromise ??= (async () => {
			stopHostUpdateChecks();
			await Promise.allSettled([
				settleSessionsForShutdown(),
				shutdownAnalytics(),
				stopWorkspaceCreations(),
			]);
			await turnTracker.drain();
			stop();
		})();
		return shutdownPromise;
	};

	if (hostUpdate) {
		void checkForHostUpdate();
		hostUpdateTimer = setInterval(() => void checkForHostUpdate(), hostUpdate.intervalMs);
	}

	const startAttributionClaimWhenReady = (): void => {
		const config = getConfig();
		if (config.analyticsEnabled && config.analyticsConsentConfirmed) startAttributionClaim();
	};

	return {
		get port() {
			return server.port ?? port;
		},
		startAttributionClaim: startAttributionClaimWhenReady,
		stop,
		shutdown,
	};
}

function restoreSeamDefaults(): void {
	setPiTrustSeed(null);
	setSessionProjectResolver(() => null);
	setTerminalPublisher(() => "unavailable");
	setFeedbackPublisher(null);
	setGithubStarPublisher(null);
	configureSurveySource(null);
	setSkillAdmissionResolver(null);
	setMcpPolicyResolver(null);
	setMcpToolGrantWriter(() => {});
	setSubagentsEnabledResolver(null);
	setSubagentConcurrencyResolver(null);
	setAgentReviewEnabledResolver(null);
	setDisabledExtensionsResolver(null);
	setExtensionSettingsResolver(null);
	setDisabledPackagesResolver(null);
	setProjectPublisher(null);
	setTerminalTabsPublisher(() => {});
	setWorkspacePublisher(null);
	setWorkspaceCreationPublisher(null);
	setWorkspaceCreationHandoff(null);
	setProjectPathGuard(null);
	setPiPackagesPublisher(null);
	setSpeechPublisher(null);
	setWatchPublisher(null);
	setSkillPathClassifier(null);
	setFsNudgePublisher(null);
	setWatchStartedPublisher(null);
	setRepoMetaPublisher(null);
	setReviewPublisher(() => {});
	setReviewFailedPublisher(() => {});
	setReviewCommentHandler(null);
	setRequestReviewHandler(null);
	setTitleToolHost(null);
	setSettingsPublisher(null);
	setSessionCreatedPublisher(() => {});
	setSessionStatePublisher(() => {});
	setSessionDeletedPublisher(() => {});
	setMcpLoginPublisher(() => {});
	setMcpStatusPublisher(() => {});
	setSessionResourcesPublisher(() => {});
	setTurnPublisher(() => {});
	setSessionPublisher(() => {});
	setExtUiPublisher(() => {});
	setLoginPublisher(() => {});
	setJbcentralAppliedPublisher(() => {});
	setJbcentralChangedPublisher(() => {});
	setLogoutPublisher(() => {});
	setModelsFilePublisher(null);
	setModelListingPublisher(null);
}

async function serveStatic(pathname: string, staticDir: string): Promise<Response> {
	const safe = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
	const requested = safe === "/" || safe === "" ? "index.html" : safe;
	const file = Bun.file(join(staticDir, requested));
	if (await file.exists()) return new Response(file);
	const index = Bun.file(join(staticDir, "index.html"));
	if (await index.exists()) return new Response(index);
	return new Response("not found", { status: 404 });
}
