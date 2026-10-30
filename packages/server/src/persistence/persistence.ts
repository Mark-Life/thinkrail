import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	type AppConfig,
	DEFAULT_CONFIG,
	type HostEnvironment,
	isComposerGrowthLimit,
	isJbcentralQuotaRefreshSeconds,
	isLineWidth,
	isLocalePreference,
	isSettleIdleDays,
	isSubagentMaxConcurrent,
	isTerminalWindowsShell,
	normalizeThemePreference,
	type Project,
	type WireModel,
	type Workspace,
} from "@thinkrail/contracts";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import {
	claimBrowserAttributionAttemptIn,
	readAcquisitionIn,
	replaceAcquisitionWithTerminalMarkerIn,
	saveAcquisitionIn,
} from "./attribution";
import type { AcquisitionRecord } from "./attributionProtocol";
import { claimAppInstalledIn, ensureInstallationIn, type InstallationRecord } from "./installation";

export {
	type AcquisitionRecord,
	ATTRIBUTION_LIFETIME_MS,
	ATTRIBUTION_MAX_POLLS,
	ATTRIBUTION_ORIGIN,
	ATTRIBUTION_POLL_INTERVAL_MS,
	type AttributionTouch,
	claimIdPattern,
	parseRedeemedAttribution,
	type RedeemedAttribution,
} from "./attributionProtocol";
export type { InstallationRecord } from "./installation";

export function dataDir(): string {
	return resolve(process.env.THINKRAIL_DATA_DIR ?? join(homedir(), ".thinkrail"));
}

function storedDirectory(path: string): string {
	if (typeof path !== "string" || !isAbsolute(path)) return path;
	return resolve(path);
}

function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(join(dataDir(), file), "utf8")) as T;
	} catch {
		return fallback;
	}
}

function writeJson(file: string, value: unknown): void {
	mkdirSync(dataDir(), { recursive: true });
	writeFileSync(join(dataDir(), file), `${JSON.stringify(value, null, "\t")}\n`);
}

function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
	mkdirSync(dataDir(), { recursive: true });
	const target = join(dataDir(), file);
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`, mode ? { mode } : undefined);
		renameSync(temporary, target);
	} finally {
		rmSync(temporary, { force: true });
	}
}

const StringMapSchema = Type.Record(Type.String(), Type.String());

export type SessionMetadataLoad<T> =
	| { kind: "loaded"; value: T }
	| { kind: "missing" }
	| { kind: "set-aside"; file: string; error: unknown; setAsidePath: string | null };

function loadSessionMetadata<T>(
	file: string,
	parse: (raw: unknown) => T | null,
): SessionMetadataLoad<T> {
	const path = join(dataDir(), file);
	let error: unknown;
	try {
		const value = parse(JSON.parse(readFileSync(path, "utf8")));
		if (value !== null) return { kind: "loaded", value };
		error = new Error(`Invalid ${file}`);
	} catch (caught) {
		if ((caught as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		error = caught;
	}
	const setAsidePath = `${path}.corrupt-${Date.now()}`;
	try {
		renameSync(path, setAsidePath);
		return { kind: "set-aside", file, error, setAsidePath };
	} catch {
		return { kind: "set-aside", file, error, setAsidePath: null };
	}
}

export const SESSION_RECEIPTS_VERSION = 1;

const SessionReceiptsSchema = Type.Object({
	version: Type.Literal(SESSION_RECEIPTS_VERSION),
	baselineComplete: Type.Boolean(),
	handledCompletionBySession: StringMapSchema,
});

export type SessionReceipts = Static<typeof SessionReceiptsSchema>;

function parseSessionReceipts(raw: unknown): SessionReceipts | null {
	return Check(SessionReceiptsSchema, raw) ? raw : null;
}

export function loadSessionReceipts(): SessionMetadataLoad<SessionReceipts> {
	return loadSessionMetadata("session-receipts.json", parseSessionReceipts);
}

export function saveSessionReceipts(receipts: SessionReceipts): void {
	writeJsonAtomic("session-receipts.json", receipts);
}

export const SESSION_LIFECYCLE_VERSION = 1;

const SessionCompletionSchema = Type.Union([
	Type.Object({
		completionId: Type.String(),
		outcome: Type.Union([
			Type.Literal("succeeded"),
			Type.Literal("interrupted"),
			Type.Literal("cancelled"),
		]),
	}),
	Type.Object({
		completionId: Type.String(),
		outcome: Type.Literal("failed"),
		failure: Type.Union([Type.Literal("error"), Type.Literal("length")]),
	}),
]);
const PersistedSessionCompletionSchema = Type.Object({
	runId: Type.String(),
	completion: SessionCompletionSchema,
});
const SessionLifecycleSchema = Type.Object({
	version: Type.Literal(SESSION_LIFECYCLE_VERSION),
	completionBySession: Type.Record(Type.String(), PersistedSessionCompletionSchema),
	cancelledRunBySession: StringMapSchema,
});

export type PersistedSessionCompletion = Static<typeof PersistedSessionCompletionSchema>;
export type SessionLifecycle = Static<typeof SessionLifecycleSchema>;

function parseSessionLifecycle(raw: unknown): SessionLifecycle | null {
	return Check(SessionLifecycleSchema, raw) ? raw : null;
}

export function loadSessionLifecycle(): SessionMetadataLoad<SessionLifecycle> {
	return loadSessionMetadata("session-lifecycle.json", parseSessionLifecycle);
}

export function saveSessionLifecycle(lifecycle: SessionLifecycle): void {
	writeJsonAtomic("session-lifecycle.json", lifecycle);
}

export const TURNS_VERSION = 1;

const TurnChangeSetSchema = Type.Object({
	id: Type.String(),
	workspaceId: Type.String(),
	sessionId: Type.String(),
	startedAt: Type.Number(),
	settledAt: Type.Number(),
	baseTree: Type.String(),
	headTree: Type.String(),
	changes: Type.Array(
		Type.Object({
			path: Type.String(),
			status: Type.Union([
				Type.Literal("added"),
				Type.Literal("modified"),
				Type.Literal("deleted"),
				Type.Literal("renamed"),
				Type.Literal("untracked"),
			]),
			added: Type.Optional(Type.Number()),
			removed: Type.Optional(Type.Number()),
		}),
	),
});
const PersistedTurnsSchema = Type.Object({
	version: Type.Literal(TURNS_VERSION),
	byWorkspace: Type.Record(Type.String(), Type.Array(TurnChangeSetSchema)),
});

export type PersistedTurns = Static<typeof PersistedTurnsSchema>;

function parseTurns(raw: unknown): PersistedTurns | null {
	return Check(PersistedTurnsSchema, raw) ? raw : null;
}

export function loadTurns(): PersistedTurns {
	const loaded = loadSessionMetadata("turns.json", parseTurns);
	return loaded.kind === "loaded" ? loaded.value : { version: TURNS_VERSION, byWorkspace: {} };
}

export function saveTurns(turns: PersistedTurns): void {
	writeJsonAtomic("turns.json", turns);
}

const PersistedTerminalTabSchema = Type.Object({
	tabKey: Type.String(),
	title: Type.String(),
	recorded: Type.Optional(Type.String()),
});
const PersistedTerminalTabsSchema = Type.Array(PersistedTerminalTabSchema);
const ListSchema = Type.Array(Type.Unknown());
const DictionarySchema = Type.Record(Type.String(), Type.Unknown());

export function loadProjects(): Project[] {
	return readJson<Project[]>("projects.json", []).map((project) => ({
		...project,
		path: storedDirectory(project.path),
	}));
}

export function saveProjects(projects: Project[]): void {
	writeJson("projects.json", projects);
}

export function loadWorkspaces(): Workspace[] {
	return readJson<Workspace[]>("workspaces.json", []).map((workspace) => ({
		...workspace,
		worktreePath: storedDirectory(workspace.worktreePath),
	}));
}

export function saveWorkspaces(workspaces: Workspace[]): void {
	writeJson("workspaces.json", workspaces);
}

export type PersistedTerminalTab = Static<typeof PersistedTerminalTabSchema>;

export type PersistedTerminalSessions = Record<string, PersistedTerminalTab[]>;

export function loadTerminalSessions(): PersistedTerminalSessions {
	const raw = readJson<unknown>("terminals.json", undefined);
	if (!Check(DictionarySchema, raw)) return {};
	const sessions: PersistedTerminalSessions = {};
	for (const [key, tabs] of Object.entries(raw)) {
		if (Check(PersistedTerminalTabsSchema, tabs)) sessions[key] = tabs;
	}
	return sessions;
}

export function saveTerminalSessions(sessions: PersistedTerminalSessions): void {
	writeJson("terminals.json", sessions);
}

const WireModelSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	provider: Type.String(),
	contextWindow: Type.Number(),
	reasoning: Type.Boolean(),
	thinkingLevels: Type.Array(
		Type.Union(
			["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) =>
				Type.Literal(level),
			),
		),
	),
	cost: Type.Optional(Type.Object({ input: Type.Number(), output: Type.Number() })),
	input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
	auth: Type.Optional(
		Type.Object({
			kind: Type.Union([
				Type.Literal("oauth"),
				Type.Literal("api-key"),
				Type.Literal("env"),
				Type.Literal("central"),
				Type.Literal("other"),
			]),
			detail: Type.Optional(Type.String()),
		}),
	),
});

/** A persisted model list keeps only entries that still identify a model; anything else is dropped, not repaired. */
function storedModels(value: unknown): WireModel[] {
	if (!Check(ListSchema, value)) return [];
	return value.filter((entry): entry is Static<typeof WireModelSchema> =>
		Check(WireModelSchema, entry),
	);
}

function storedExtensionNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [
		...new Set(
			value.filter((name): name is string => typeof name === "string" && name.trim().length > 0),
		),
	];
}

export function loadConfig(): AppConfig {
	const value = readJson<unknown>("config.json", undefined);
	if (!Check(DictionarySchema, value)) return structuredClone(DEFAULT_CONFIG);
	const extensions = { ...value };
	delete extensions.chatMessageOrder;
	delete extensions.layout;
	delete extensions.themeMode;
	delete extensions.systemThemePair;
	return {
		...extensions,
		...normalizeThemePreference(value),
		analyticsEnabled:
			typeof value.analyticsEnabled === "boolean"
				? value.analyticsEnabled
				: DEFAULT_CONFIG.analyticsEnabled,
		analyticsConsentConfirmed: value.analyticsConsentConfirmed === true,
		notificationsEnabled:
			typeof value.notificationsEnabled === "boolean"
				? value.notificationsEnabled
				: DEFAULT_CONFIG.notificationsEnabled,
		terminalReplayKb:
			typeof value.terminalReplayKb === "number" && Number.isFinite(value.terminalReplayKb)
				? value.terminalReplayKb
				: DEFAULT_CONFIG.terminalReplayKb,
		composerGrowthLimit: isComposerGrowthLimit(value.composerGrowthLimit)
			? value.composerGrowthLimit
			: DEFAULT_CONFIG.composerGrowthLimit,
		chatLineWidth: isLineWidth(value.chatLineWidth)
			? value.chatLineWidth
			: DEFAULT_CONFIG.chatLineWidth,
		fileLineWidth: isLineWidth(value.fileLineWidth)
			? value.fileLineWidth
			: DEFAULT_CONFIG.fileLineWidth,
		chatLineWidthBounded:
			typeof value.chatLineWidthBounded === "boolean"
				? value.chatLineWidthBounded
				: DEFAULT_CONFIG.chatLineWidthBounded,
		fileLineWidthBounded:
			typeof value.fileLineWidthBounded === "boolean"
				? value.fileLineWidthBounded
				: DEFAULT_CONFIG.fileLineWidthBounded,
		reviewAutoFix:
			typeof value.reviewAutoFix === "boolean" ? value.reviewAutoFix : DEFAULT_CONFIG.reviewAutoFix,
		agentReviewEnabled:
			typeof value.agentReviewEnabled === "boolean"
				? value.agentReviewEnabled
				: DEFAULT_CONFIG.agentReviewEnabled,
		subagentsEnabled:
			typeof value.subagentsEnabled === "boolean"
				? value.subagentsEnabled
				: DEFAULT_CONFIG.subagentsEnabled,
		subagentMaxConcurrent: isSubagentMaxConcurrent(value.subagentMaxConcurrent)
			? value.subagentMaxConcurrent
			: DEFAULT_CONFIG.subagentMaxConcurrent,
		jbcentralQuotaEnabled:
			typeof value.jbcentralQuotaEnabled === "boolean"
				? value.jbcentralQuotaEnabled
				: DEFAULT_CONFIG.jbcentralQuotaEnabled,
		jbcentralQuotaRefreshSeconds: isJbcentralQuotaRefreshSeconds(value.jbcentralQuotaRefreshSeconds)
			? value.jbcentralQuotaRefreshSeconds
			: DEFAULT_CONFIG.jbcentralQuotaRefreshSeconds,
		customLayoutPresets: Array.isArray(value.customLayoutPresets)
			? value.customLayoutPresets
			: DEFAULT_CONFIG.customLayoutPresets,
		favoriteModels: storedModels(value.favoriteModels),
		recentModels: storedModels(value.recentModels),
		terminalWindowsShell: isTerminalWindowsShell(value.terminalWindowsShell)
			? value.terminalWindowsShell
			: DEFAULT_CONFIG.terminalWindowsShell,
		settleIdleDays: isSettleIdleDays(value.settleIdleDays)
			? value.settleIdleDays
			: DEFAULT_CONFIG.settleIdleDays,
		disabledExtensions: storedExtensionNames(value.disabledExtensions),
		locale: isLocalePreference(value.locale) ? value.locale : DEFAULT_CONFIG.locale,
		onboardingDismissed: value.onboardingDismissed === true,
	};
}

export function saveConfig(config: AppConfig): void {
	writeJson("config.json", config);
}

const HostEnvironmentFileSchema = Type.Object({
	agentDir: Type.Optional(Type.Unknown()),
	vars: Type.Optional(Type.Unknown()),
});
const HostEnvironmentVarSchema = Type.Object({ name: Type.String(), value: Type.String() });
const AgentDirSchema = Type.String({ minLength: 1 });

export function loadHostEnvironment(): HostEnvironment {
	const raw = readJson<unknown>("environment.json", undefined);
	const value = Check(HostEnvironmentFileSchema, raw) ? raw : {};
	const vars = Check(ListSchema, value.vars)
		? value.vars.filter((entry): entry is Static<typeof HostEnvironmentVarSchema> =>
				Check(HostEnvironmentVarSchema, entry),
			)
		: [];
	return {
		...(Check(AgentDirSchema, value.agentDir) ? { agentDir: value.agentDir } : {}),
		vars: vars.map(({ name, value }) => ({ name, value })),
	};
}

export function saveHostEnvironment(environment: HostEnvironment): void {
	writeJsonAtomic("environment.json", environment, 0o600);
}

export function ensureInstallation(): InstallationRecord {
	return ensureInstallationIn(dataDir());
}

export function claimAppInstalled(): boolean {
	return claimAppInstalledIn(dataDir());
}

export function readAcquisition(now = Date.now()): AcquisitionRecord | undefined {
	return readAcquisitionIn(dataDir(), now);
}

export function claimBrowserAttributionAttempt(): boolean {
	return claimBrowserAttributionAttemptIn(dataDir());
}

export function saveAcquisition(record: AcquisitionRecord): void {
	saveAcquisitionIn(dataDir(), record);
}

export function replaceAcquisitionWithTerminalMarker(): void {
	replaceAcquisitionWithTerminalMarkerIn(dataDir());
}
