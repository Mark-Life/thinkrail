import type {
	AppConfig,
	AppConfigUpdate,
	AppSurvey,
	BackgroundCommandCompletionDetails,
	CompletionDelivery,
	ExtensionCatalogEntry,
	HistoryScope,
	HistorySearchResult,
	HostEnvironment,
	HostEnvironmentStatus,
	HostEnvironmentUpdateResult,
	InstalledFontsResult,
	LocalLocalesSnapshot,
	McpExposure,
	McpListResult,
	McpReadOutputResult,
	McpServerEntryInput,
	McpServerLog,
	McpServerScope,
	McpStatusSnapshot,
	PiPackageResourceType,
	PiPackageScope,
	PiPackageSummary,
	PiPackagesCatalog,
	ReviewFixDetails,
	SubagentCompletionDetails,
	SurveyInvitationResponse,
	SurveySubmitParams,
	UserFontsSnapshot,
	UserThemesSnapshot,
} from "./domain";
import { isDelegationRunDetails } from "./domain";
import type { ToolResponseDetails, ToolResponsePendingDetails } from "./piProtocol";
import type {
	Ack,
	ModelContextSetting,
	Project,
	SessionSummary,
	SkillCatalogEntry,
	SlashCommandInfo,
	TerminalTabInfo,
	WireCustomMessage,
	WsSchemaMethodMap,
} from "./schema";

export interface TerminalDataPush {
	id: string;
	data: string;
	truncated?: boolean;
}

export interface TerminalExitPush {
	id: string;
	exitCode: number;
}

export interface TerminalDetachedPush {
	workspaceId: string;
	tabKey: string;
}

export const INITIAL_TERMINAL_TAB_KEY = "thinkrail-initial";

export interface TerminalTabsPush {
	workspaceId: string;
	tabs: TerminalTabInfo[];
}

export const PROTOCOL_VERSION = 102;
export const FONTS_PROTOCOL_VERSION = 102;
export const CUSTOM_ENDPOINTS_PROTOCOL_VERSION = 101;
export const PI_PACKAGES_PROTOCOL_VERSION = 100;
export const PROVIDER_WARNINGS_PROTOCOL_VERSION = 99;
export const SURVEY_TRANSLATIONS_PROTOCOL_VERSION = 98;
export const RESOURCE_HISTORY_PROTOCOL_VERSION = 96;
export const PROJECT_CLONE_PROTOCOL_VERSION = 95;
export const ONBOARDING_PROTOCOL_VERSION = 94;
export const LAYOUT_PLAN_PRESET_PROTOCOL_VERSION = 94;
export const TOOL_RESPONSE_PROTOCOL_VERSION = 93;
export const USER_THEMES_PROTOCOL_VERSION = 92;
export const HOST_ENVIRONMENT_PROTOCOL_VERSION = 91;
export const CLIENT_ERROR_REPORT_PROTOCOL_VERSION = 90;
export const LOCALES_PROTOCOL_VERSION = 89;
export const REVIEW_ACTIONS_PROTOCOL_VERSION = 88;
export const BRANCH_STATUS_PROTOCOL_VERSION = 87;
export const WORKSPACE_READ_STATE_PROTOCOL_VERSION = 86;
export const PROJECT_RENAME_PROTOCOL_VERSION = 85;
export const MCP_TOOL_GRANTS_PROTOCOL_VERSION = 84;
export const MCP_PROTOCOL_VERSION = 83;
export const EXTENSION_CATALOG_PROTOCOL_VERSION = 82;
export const PROJECT_TRUST_PROTOCOL_VERSION = 81;
export const TURN_CHANGES_PROTOCOL_VERSION = 80;
export const SUBAGENT_CONCURRENCY_PROTOCOL_VERSION = 79;
export const WORKSPACE_SETTLE_PROTOCOL_VERSION = 78;
export const MODEL_PICKER_PROTOCOL_VERSION = 77;
export const CONTEXT_WINDOW_SETTINGS_PROTOCOL_VERSION = 76;
export const CHANGE_MUTATIONS_PROTOCOL_VERSION = 75;
export const RESOURCE_META_PROTOCOL_VERSION = 75;
export const REVIEW_RICH_ANCHORS_PROTOCOL_VERSION = 74;
export const DEFAULT_MODEL_PROTOCOL_VERSION = 72;
export const CHAT_RESOURCES_PROTOCOL_VERSION = 71;
export const HOST_UPDATE_RUN_PROTOCOL_VERSION = 70;
export const PLAN_REVIEW_SUBAGENT_PROTOCOL_VERSION = 67;
export const AGENT_REVIEW_SETTING_PROTOCOL_VERSION = 68;
export const PLAN_SUMMARY_GENERATION_PROTOCOL_VERSION = 69;
export const SESSION_STATE_PROTOCOL_VERSION = 73;
export const ANALYTICS_CONSENT_PROTOCOL_VERSION = 65;
export const SESSION_RENAME_PROTOCOL_VERSION = 66;
export const SESSION_TITLE_MAX_LENGTH = 80;

export function normalizeSessionTitle(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const title = value.replace(/[\r\n]+/g, " ").trim();
	return title.length > 0 && title.length <= SESSION_TITLE_MAX_LENGTH ? title : null;
}

export const WINDOWS_SHELL_SETTINGS_PROTOCOL_VERSION = 62;
export const PROJECT_TEMPLATE_PREVIEW_PROTOCOL_VERSION = 63;
export const THEME_SYSTEM_PROTOCOL_VERSION = 58;
export const SUBAGENT_SETTINGS_PROTOCOL_VERSION = 57;
export const JBCENTRAL_QUOTA_PROTOCOL_VERSION = 59;
export const WORKSPACE_RENAME_PROTOCOL_VERSION = 55;
export const FEEDBACK_SURVEY_PROTOCOL_VERSION = 97;

export type HostPlatform = "darwin" | "linux" | "win32";

export type HostUpdateStatus = "available" | "running" | "succeeded" | "failed";

export interface HostUpdateNotice {
	currentVersion: string;
	availableVersion: string;
	channel: string;
	status?: HostUpdateStatus;
}

export interface ServerWelcome {
	protocolVersion: number;
	appVersion?: string;
	hostPlatform?: HostPlatform;
	hostUpdate?: HostUpdateNotice;
	projects: Project[];
	recentProjects: Project[];
	config: AppConfig;
}

export interface WorkspaceRemoved {
	projectId: string;
	id: string;
}

export type SessionCreatedPayload = SessionSummary;

export interface SessionDeletedPayload {
	workspaceId: string;
	sessionId: string;
}

export const WS_METHODS = {
	projectOpen: "project.open",
	projectList: "project.list",
	projectClose: "project.close",
	projectRename: "project.rename",
	projectInspect: "project.inspect",
	projectInit: "project.init",
	projectCreate: "project.create",
	projectCloneDestination: "project.cloneDestination",
	projectClone: "project.clone",
	projectCancelClone: "project.cancelClone",
	projectHasSpecs: "project.hasSpecs",
	projectSetTrust: "project.setTrust",
	projectAcknowledgeSkills: "project.acknowledgeSkills",
	projectSetSkillEnabled: "project.setSkillEnabled",
	projectAliasSkills: "project.aliasSkills",
	projectTrustSummary: "project.trustSummary",
	projectSetGroupEnabled: "project.setGroupEnabled",
	projectSkills: "project.skills",
	workspaceCreate: "workspace.create",
	workspaceRename: "workspace.rename",
	workspaceListExisting: "workspace.listExisting",
	workspaceOpenExisting: "workspace.openExisting",
	workspaceList: "workspace.list",
	workspaceOpenReview: "workspace.openReview",
	workspaceBranchStatus: "workspace.branchStatus",
	workspacePush: "workspace.push",
	workspaceDeleteRemoteBranch: "workspace.deleteRemoteBranch",
	workspaceRemove: "workspace.remove",
	workspaceDiffStats: "workspace.diffStats",
	workspaceSetSkillOverride: "workspace.setSkillOverride",
	workspaceSetSubagentsOverride: "workspace.setSubagentsOverride",
	workspaceSetSubagentMaxConcurrent: "workspace.setSubagentMaxConcurrent",
	workspaceSetDiffBase: "workspace.setDiffBase",
	workspaceSettle: "workspace.settle",
	workspaceUnsettle: "workspace.unsettle",
	workspaceMarkUnread: "workspace.markUnread",
	workspaceMarkRead: "workspace.markRead",
	workspaceWatchReady: "workspace.watchReady",
	workspaceOpenIn: "workspace.openIn",
	workspaceReveal: "workspace.reveal",
	editorList: "editor.list",
	gitListBranches: "git.listBranches",
	gitPrefetch: "git.prefetch",
	githubAuthStatus: "github.authStatus",
	githubRefresh: "github.refresh",
	prPreview: "pr.preview",
	prOpen: "pr.open",
	prGenerate: "pr.generate",
	prReady: "pr.ready",
	prMerge: "pr.merge",
	prReopen: "pr.reopen",
	fsReadDir: "fs.readDir",
	fsReadFile: "fs.readFile",
	specGraph: "spec.graph",
	todoList: "todo.list",
	todoAdd: "todo.add",
	todoUpdate: "todo.update",
	todoRemove: "todo.remove",
	todoReview: "todo.review",
	todoRequestFix: "todo.requestFix",
	todoStartReview: "todo.startReview",
	todoReviewAll: "todo.reviewAll",
	todoGenerateSummary: "todo.generateSummary",
	gitStatus: "git.status",
	gitDiffFile: "git.diffFile",
	gitListCommits: "git.listCommits",
	workspaceTurns: "workspace.turns",
	changeRevert: "change.revert",
	changeUndo: "change.undo",
	terminalReserve: "terminal.reserve",
	terminalAttach: "terminal.attach",
	terminalList: "terminal.list",
	terminalWrite: "terminal.write",
	terminalResize: "terminal.resize",
	terminalClose: "terminal.close",
	dialogSelectDirectory: "dialog.selectDirectory",
	skillList: "skill.list",
	skillsState: "skills.state",
	extensionList: "extension.list",
	packagesList: "packages.list",
	packagesInstall: "packages.install",
	packagesRemove: "packages.remove",
	packagesUpdate: "packages.update",
	packagesCheckUpdates: "packages.checkUpdates",
	packagesSetResourceEnabled: "packages.setResourceEnabled",
	packagesReveal: "packages.reveal",
	localesList: "locales.list",
	localesReveal: "locales.reveal",
	themesList: "themes.list",
	themesReveal: "themes.reveal",
	fontsList: "fonts.list",
	fontsInstalled: "fonts.installed",
	fontsReveal: "fonts.reveal",
	sessionCreate: "session.create",
	sessionPrompt: "session.prompt",
	sessionSteer: "session.steer",
	sessionFollowUp: "session.followUp",
	sessionClearQueue: "session.clearQueue",
	sessionRemoveQueued: "session.removeQueued",
	sessionAbort: "session.abort",
	sessionDispose: "session.dispose",
	sessionDelete: "session.delete",
	sessionRename: "session.rename",
	sessionSetModel: "session.setModel",
	sessionSetThinkingLevel: "session.setThinkingLevel",
	sessionCompact: "session.compact",
	sessionGetStats: "session.getStats",
	sessionGetCommands: "session.getCommands",
	sessionReloadResources: "session.reloadResources",
	sessionExtUiReply: "session.extUiReply",
	sessionRespondToTool: "session.respondToTool",
	sessionAnswerQuestion: "session.answerQuestion",
	sessionList: "session.list",
	sessionStateList: "session.stateList",
	sessionAcknowledgeCompletion: "session.acknowledgeCompletion",
	sessionNudge: "session.nudge",
	sessionActivityList: "session.activityList",
	sessionGetMessages: "session.getMessages",
	subagentGetTranscript: "subagent.getTranscript",
	sessionResources: "session.resources",
	sessionResourceHistory: "session.resourceHistory",
	backgroundCommandOutput: "backgroundCommand.output",
	backgroundCommandStop: "backgroundCommand.stop",
	subagentStop: "subagent.stop",
	subagentStopAll: "subagent.stopAll",
	modelList: "model.list",
	modelRefresh: "model.refresh",
	modelDefault: "model.default",
	modelContextSettings: "model.contextSettings",
	modelSetContextWindow: "model.setContextWindow",
	customEndpointsList: "customEndpoints.list",
	customEndpointsProbe: "customEndpoints.probe",
	customEndpointsSave: "customEndpoints.save",
	customEndpointsRemove: "customEndpoints.remove",
	modelClampThinking: "model.clampThinking",
	providerStatus: "provider.status",
	providerDetect: "provider.detect",
	providerLoginStart: "provider.loginStart",
	providerLoginReply: "provider.loginReply",
	providerLoginCancel: "provider.loginCancel",
	providerLogout: "provider.logout",
	providerDisableWarning: "provider.disableWarning",
	providerJbcentralConnect: "provider.jbcentralConnect",
	providerJbcentralDisconnect: "provider.jbcentralDisconnect",
	providerJbcentralStartProxy: "provider.jbcentralStartProxy",
	providerJbcentralLogin: "provider.jbcentralLogin",
	providerJbcentralUpdate: "provider.jbcentralUpdate",
	providerJbcentralQuota: "provider.jbcentralQuota",
	hostUpdate: "host.update",
	settingsUpdate: "settings.update",
	environmentGet: "environment.get",
	environmentUpdate: "environment.update",
	feedbackRespond: "feedback.respond",
	feedbackSurvey: "feedback.survey",
	feedbackSurveySubmit: "feedback.survey.submit",
	clientReportError: "client.reportError",
	historySearch: "history.search",
	reviewGet: "review.get",
	reviewCommentAdd: "review.commentAdd",
	reviewCommentUpdate: "review.commentUpdate",
	reviewCommentDelete: "review.commentDelete",
	reviewFileDone: "review.fileDone",
	reviewSendComment: "review.sendComment",
	reviewSendBatch: "review.sendBatch",
	reviewClose: "review.close",
	templateList: "template.list",
	templateGet: "template.get",
	templateSave: "template.save",
	templateDelete: "template.delete",
	mcpList: "mcp.list",
	mcpAdd: "mcp.add",
	mcpUpdate: "mcp.update",
	mcpRemove: "mcp.remove",
	mcpSetProjectOverride: "mcp.setProjectOverride",
	mcpSetSessionOverride: "mcp.setSessionOverride",
	mcpApprove: "mcp.approve",
	mcpRevokeToolGrant: "mcp.revokeToolGrant",
	mcpShareWithRepo: "mcp.shareWithRepo",
	mcpLogin: "mcp.login",
	mcpLogout: "mcp.logout",
	mcpTestConnection: "mcp.testConnection",
	mcpReconnect: "mcp.reconnect",
	mcpReadOutput: "mcp.readOutput",
	mcpReadLog: "mcp.readLog",
} as const;

export const WS_CHANNELS = {
	serverWelcome: "server.welcome",
	projectUpdated: "project.updated",
	piEvent: "pi.event",
	piExtensionUi: "pi.extensionUi",
	sessionCreated: "session.created",
	sessionDeleted: "session.deleted",
	sessionResourcesChanged: "session.resourcesChanged",
	sessionState: "session.state",
	providerLogin: "provider.login",
	providerChanged: "provider.changed",
	terminalData: "terminal.data",
	terminalExit: "terminal.exit",
	terminalDetached: "terminal.detached",
	terminalTabs: "terminal.tabs",
	workspaceCreated: "workspace.created",
	workspaceUpdated: "workspace.updated",
	workspaceRemoved: "workspace.removed",
	workspaceFsChanged: "workspace.fsChanged",
	settingsChanged: "settings.changed",
	hostUpdateAvailable: "host.updateAvailable",
	feedbackInterview: "feedback.interview",
	reviewChanged: "review.changed",
	reviewFailed: "review.failed",
	turnChanged: "turn.changed",
	mcpStatus: "mcp.status",
	localesChanged: "locales.changed",
	themesChanged: "themes.changed",
	packagesChanged: "packages.changed",
	fontsChanged: "fonts.changed",
} as const;

type SameUnion<A extends B, B extends C, C = A> = A;
export type WsChannel = (typeof WS_CHANNELS)[keyof typeof WS_CHANNELS];

export const TOOL_RESPONSE_CUSTOM_TYPE = "tool-response";
const LEGACY_ASK_ANSWERS_CUSTOM_TYPE = "ask-user-answers";

export interface ToolResponseMessage extends WireCustomMessage<ToolResponseDetails> {
	customType: typeof TOOL_RESPONSE_CUSTOM_TYPE;
	details: ToolResponseDetails;
}

export function isToolResponsePending(details: unknown): details is ToolResponsePendingDetails {
	return (
		!!details &&
		typeof details === "object" &&
		(details as ToolResponsePendingDetails).kind === "ack"
	);
}

export function readToolResponseMessage(message: unknown): ToolResponseDetails | null {
	if (!message || typeof message !== "object") return null;
	const m = message as { role?: unknown; customType?: unknown; details?: unknown };
	if (m.role !== "custom" || !m.details || typeof m.details !== "object") return null;
	const details = m.details as { toolCallId?: unknown; response?: unknown; result?: unknown };
	if (typeof details.toolCallId !== "string") return null;
	if (m.customType === TOOL_RESPONSE_CUSTOM_TYPE && "response" in details)
		return { toolCallId: details.toolCallId, response: details.response };
	if (m.customType === LEGACY_ASK_ANSWERS_CUSTOM_TYPE && details.result !== undefined)
		return { toolCallId: details.toolCallId, response: details.result };
	return null;
}

export const SUBAGENT_COMPLETION_CUSTOM_TYPE = "subagent-completion";

export interface SubagentCompletionMessage extends WireCustomMessage<SubagentCompletionDetails> {
	customType: typeof SUBAGENT_COMPLETION_CUSTOM_TYPE;
	details: SubagentCompletionDetails;
}

export function completionDelivery(details: {
	delivery?: unknown;
}): CompletionDelivery | undefined {
	const { delivery } = details;
	return delivery === "wake" || delivery === "run" || delivery === "appended"
		? delivery
		: undefined;
}

export function isSubagentCompletionMessage(
	message: unknown,
): message is SubagentCompletionMessage {
	if (!message || typeof message !== "object") return false;
	const m = message as { role?: unknown; customType?: unknown; details?: unknown };
	if (m.role !== "custom" || m.customType !== SUBAGENT_COMPLETION_CUSTOM_TYPE) return false;
	return isDelegationRunDetails(m.details);
}

export const TODO_REVIEW_FIX_CUSTOM_TYPE = "todo-review-fix";

export interface TodoReviewFixMessage extends WireCustomMessage<ReviewFixDetails> {
	customType: typeof TODO_REVIEW_FIX_CUSTOM_TYPE;
	details: ReviewFixDetails;
}

export function isTodoReviewFixMessage(message: unknown): message is TodoReviewFixMessage {
	if (!message || typeof message !== "object") return false;
	const m = message as { role?: unknown; customType?: unknown; details?: unknown };
	if (m.role !== "custom" || m.customType !== TODO_REVIEW_FIX_CUSTOM_TYPE) return false;
	const details = m.details as Partial<ReviewFixDetails> | undefined;
	return (
		typeof details?.itemId === "string" &&
		typeof details.itemTitle === "string" &&
		Array.isArray(details.comments)
	);
}

export const BACKGROUND_COMMAND_COMPLETION_CUSTOM_TYPE = "background-command-completion";

export interface BackgroundCommandCompletionMessage
	extends WireCustomMessage<BackgroundCommandCompletionDetails> {
	customType: typeof BACKGROUND_COMMAND_COMPLETION_CUSTOM_TYPE;
	display: true;
	details: BackgroundCommandCompletionDetails;
}

export function isBackgroundCommandCompletionMessage(
	message: unknown,
): message is BackgroundCommandCompletionMessage {
	if (!message || typeof message !== "object") return false;
	const m = message as {
		role?: unknown;
		customType?: unknown;
		display?: unknown;
		details?: unknown;
	};
	if (
		m.role !== "custom" ||
		m.customType !== BACKGROUND_COMMAND_COMPLETION_CUSTOM_TYPE ||
		m.display !== true
	)
		return false;
	if (!m.details || typeof m.details !== "object") return false;
	const d = m.details as Partial<BackgroundCommandCompletionDetails>;
	if ([d.id, d.sessionId, d.name].some((field) => typeof field !== "string")) return false;
	if (d.status !== "completed" && d.status !== "error" && d.status !== "stopped") return false;
	if (
		typeof d.startedAt !== "number" ||
		!Number.isFinite(d.startedAt) ||
		typeof d.finishedAt !== "number" ||
		!Number.isFinite(d.finishedAt)
	)
		return false;
	if (
		d.exitCode !== undefined &&
		d.exitCode !== null &&
		(typeof d.exitCode !== "number" || !Number.isFinite(d.exitCode))
	)
		return false;
	if (d.errorMessage !== undefined && typeof d.errorMessage !== "string") return false;
	return !!d.output && typeof d.output.text === "string" && typeof d.output.truncated === "boolean";
}

export function customMessageText(content: WireCustomMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
		.map((c) => c.text)
		.join("");
}

export type ClientErrorKind = "render" | "window" | "rejection";

export interface ClientErrorReport {
	kind: ClientErrorKind;
	type: string;
	stack?: string;
	boundary?: string;
	chunkIds?: Record<string, string>;
}

export const MODEL_CONTEXT_WINDOW_LIMITS = { min: 272_000, max: 1_000_000 } as const;

export function isModelContextWindow(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= MODEL_CONTEXT_WINDOW_LIMITS.min &&
		value <= MODEL_CONTEXT_WINDOW_LIMITS.max
	);
}

/** Provider ids the custom-endpoint form owns in pi's `models.json`; every other provider is left alone. */
export const CUSTOM_ENDPOINT_ID_PREFIX = "custom-";

export function isCustomEndpointId(id: string): boolean {
	return id.startsWith(CUSTOM_ENDPOINT_ID_PREFIX);
}

export function isSharedModelContextTarget(
	setting: Pick<ModelContextSetting, "override">,
): boolean {
	return setting.override === null || isModelContextWindow(setting.override);
}

/**
 * The entry a rewrite or removal was rendered from: its scope and the `McpServerSummary.fingerprint` the
 * client rendered it with. The host refuses the write when the entry on disk no longer has it.
 */
export interface McpRenderedTarget {
	scope: McpServerScope;
	expectedFingerprint: string;
}

export interface WsMethodMap extends WsSchemaMethodMap {
	"dialog.selectDirectory": { params: Record<string, never>; result: { path: string | null } };
	"skill.list": { params: { projectId: string }; result: SlashCommandInfo[] };
	"skills.state": { params: { workspaceId: string }; result: SkillCatalogEntry[] };
	"extension.list": { params: Record<string, never>; result: ExtensionCatalogEntry[] };
	"packages.list": { params: { workspaceId?: string }; result: PiPackagesCatalog };
	"packages.install": {
		params: { source: string; scope: PiPackageScope; workspaceId?: string };
		result: PiPackageSummary;
	};
	"packages.remove": {
		params: { source: string; scope: PiPackageScope; workspaceId?: string };
		result: Ack;
	};
	"packages.update": {
		params: { packages: { source: string; scope: PiPackageScope }[]; workspaceId?: string };
		result: Ack;
	};
	"packages.checkUpdates": {
		params: { workspaceId?: string; force?: boolean };
		result: { source: string; scope: PiPackageScope }[];
	};
	"packages.setResourceEnabled": {
		params: {
			path: string;
			type: PiPackageResourceType;
			scope: PiPackageScope;
			enabled: boolean;
			workspaceId?: string;
		};
		result: Ack;
	};
	"packages.reveal": { params: { path: string; workspaceId?: string }; result: Ack };
	"locales.list": { params: Record<string, never>; result: LocalLocalesSnapshot };
	"locales.reveal": { params: Record<string, never>; result: Ack };
	"themes.list": { params: Record<string, never>; result: UserThemesSnapshot };
	"themes.reveal": { params: Record<string, never>; result: Ack };
	"fonts.list": { params: Record<string, never>; result: UserFontsSnapshot };
	"fonts.installed": { params: Record<string, never>; result: InstalledFontsResult };
	"fonts.reveal": { params: Record<string, never>; result: Ack };
	"host.update": { params: Record<string, never>; result: Ack };
	"settings.update": { params: { config: AppConfigUpdate }; result: AppConfig };
	"environment.get": { params: Record<string, never>; result: HostEnvironmentStatus };
	"environment.update": {
		params: { environment: HostEnvironment };
		result: HostEnvironmentUpdateResult;
	};
	"feedback.respond": { params: { action: SurveyInvitationResponse }; result: Ack };
	"feedback.survey": {
		params: { language?: string };
		result: { survey: AppSurvey | null };
	};
	"feedback.survey.submit": { params: SurveySubmitParams; result: Ack };
	"client.reportError": { params: ClientErrorReport; result: Ack };
	"history.search": {
		params: { query: string; scope: HistoryScope; limit?: number };
		result: HistorySearchResult;
	};
	"mcp.list": { params: { workspaceId: string }; result: McpListResult };
	"mcp.add": {
		params: {
			workspaceId: string;
			scope: McpServerScope;
			name: string;
			entry: McpServerEntryInput;
		};
		result: McpListResult;
	};
	"mcp.update": {
		params: { workspaceId: string; name: string; entry: McpServerEntryInput } & McpRenderedTarget;
		result: McpListResult;
	};
	"mcp.remove": {
		params: { workspaceId: string; name: string } & McpRenderedTarget;
		result: McpListResult;
	};
	"mcp.setProjectOverride": {
		params: {
			workspaceId: string;
			name: string;
			enabled?: boolean;
			exposure?: Exclude<McpExposure, "codemode">;
		};
		result: McpListResult;
	};
	"mcp.setSessionOverride": {
		params: { workspaceId: string; sessionId: string; name: string; enabled: boolean };
		result: Ack;
	};
	"mcp.approve": {
		params: { workspaceId: string; name: string; fingerprint: string };
		result: McpListResult;
	};
	"mcp.revokeToolGrant": {
		params: { workspaceId: string; name: string; tool: string };
		result: McpListResult;
	};
	"mcp.shareWithRepo": { params: { workspaceId: string; name: string }; result: McpListResult };
	"mcp.login": { params: { workspaceId: string; name: string }; result: { loginId: string } };
	"mcp.logout": { params: { workspaceId: string; name: string }; result: Ack };
	"mcp.testConnection": {
		params: { workspaceId: string; name: string };
		result: { loginId: string };
	};
	"mcp.reconnect": {
		params: { workspaceId: string; sessionId: string; name: string };
		result: Ack;
	};
	"mcp.readOutput": {
		params: { workspaceId: string; sessionId: string; toolCallId: string };
		result: McpReadOutputResult;
	};
	"mcp.readLog": { params: { workspaceId: string; name: string }; result: McpServerLog };
}

/** Payload of the `mcp.status` channel: one per-session snapshot per publish. */
export type McpStatusPayload = McpStatusSnapshot;

export type WsMethodName = SameUnion<
	keyof WsMethodMap,
	(typeof WS_METHODS)[keyof typeof WS_METHODS]
>;
export type WsParams<M extends WsMethodName> = WsMethodMap[M]["params"];
export type WsResult<M extends WsMethodName> = WsMethodMap[M]["result"];

export interface WsRequest<M extends WsMethodName = WsMethodName> {
	id: string;
	method: M;
	params: WsParams<M>;
	sessionId?: string;
}

export interface WsAck {
	ack: string[];
}

export interface WsResume {
	resume: string[];
}

export type WsClientMessage = WsRequest | WsAck | WsResume;

export type WsErrorCode =
	| "UNKNOWN_COMMIT"
	| "PUSH_AUTH_FAILED"
	| "NOT_GIT"
	| "ALREADY_OPEN"
	| "PROJECT_CLONE_INVALID"
	| "PROJECT_CLONE_FAILED"
	| "PROJECT_CLONE_CLEANUP_FAILED"
	| "SUBAGENT_TRANSCRIPT_NOT_FOUND"
	| "RESOURCE_UNAVAILABLE"
	| "STALE_VIEW"
	| "SCOPE_IMMUTABLE"
	| "RANGE_INVALID"
	| "RECEIPT_UNKNOWN"
	| "UNSUPPORTED_CHANGE"
	| "LOGIN_NOT_OWNER"
	| "MCP_CONFIG_INVALID"
	| "MCP_PATH_UNSAFE"
	| "MCP_HANDLED_ELSEWHERE"
	| "SURVEY_UNAVAILABLE"
	| "SURVEY_CHANGED"
	| "SURVEY_INVALID"
	| "SURVEY_NOT_SENT"
	| "PACKAGE_SOURCE_INVALID"
	| "PACKAGE_OFFLINE"
	| "PACKAGE_UNTRUSTED"
	| "PACKAGE_UNKNOWN"
	| "PACKAGE_INSTALL_FAILED"
	| "PACKAGE_INSTALLED_UNLISTED"
	| "PACKAGE_REMOVE_FAILED"
	| "PACKAGE_UPDATE_FAILED"
	| "PACKAGE_SETTINGS_WRITE_FAILED"
	| "REQUEST_REPLAY_OVERFLOW"
	| "INSTALLED_FONTS_UNAVAILABLE"
	| "INVALID_PARAMS";

export interface WsResponse {
	id: string;
	ok: boolean;
	result?: unknown;
	error?: string;
	errorCode?: WsErrorCode;
}

export interface WsPush {
	channel: WsChannel;
	data: unknown;
}

export type WsServerMessage = WsResponse | WsPush;
