import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	arr,
	bool,
	compile,
	lit,
	map,
	obj,
	opt,
	type Static,
	str,
	type Validator,
} from "@earendil-works/pi-schema";
import {
	type AppConfig,
	DEFAULT_CONFIG,
	type HostEnvironment,
	HostEnvironmentVar,
	isComposerGrowthLimit,
	isJbcentralQuotaRefreshSeconds,
	isLineWidth,
	isLocalePreference,
	isSettleIdleDays,
	isSubagentMaxConcurrent,
	isTerminalWindowsShell,
	JsonObject,
	normalizeFontSettings,
	normalizeThemePreference,
	Project,
	SessionCompletion,
	ThinkingLevel,
	TurnChangeSet,
	WireModel,
	Workspace,
} from "@thinkrail/contracts";
import {
	claimBrowserAttributionAttemptIn,
	readAcquisitionIn,
	replaceAcquisitionWithTerminalMarkerIn,
	saveAcquisitionIn,
} from "./attribution";
import type { AcquisitionRecord } from "./attributionProtocol";
import { claimAppInstalledIn, ensureInstallationIn, type InstallationRecord } from "./installation";
import {
	assertOverwriteAllowed,
	hasErrorCode,
	isOverwriteRefused,
	parseEntries,
	readStateFile,
	type StateFile,
} from "./stateFile";

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
export {
	assertOverwriteAllowed,
	observeStateFileProblems,
	parseEntryRecord,
	readStateFile,
} from "./stateFile";

export function dataDir(): string {
	return resolve(process.env.THINKRAIL_DATA_DIR ?? join(homedir(), ".thinkrail"));
}

function storedDirectory(path: string): string {
	return isAbsolute(path) ? resolve(path) : path;
}

function openStateFile(file: string): StateFile {
	return readStateFile(join(dataDir(), file));
}

function readStoredObject(file: StateFile): Record<string, unknown> {
	if (JsonObject.check(file.value)) return file.value;
	if (file.value !== undefined) file.setAside("not an object");
	return {};
}

function writeJson(file: string, value: unknown): void {
	assertOverwriteAllowed(join(dataDir(), file));
	mkdirSync(dataDir(), { recursive: true });
	writeFileSync(join(dataDir(), file), `${JSON.stringify(value, null, "\t")}\n`);
}

function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
	mkdirSync(dataDir(), { recursive: true });
	const target = join(dataDir(), file);
	assertOverwriteAllowed(target);
	const temporary = `${target}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`, mode ? { mode } : undefined);
		renameSync(temporary, target);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export type SessionMetadataLoad<T> =
	| { kind: "loaded"; value: T }
	| { kind: "missing" }
	| { kind: "set-aside"; file: string; error: unknown; setAsidePath: string | null };

function loadSessionMetadata<T>(file: string, validator: Validator<T>): SessionMetadataLoad<T> {
	const path = join(dataDir(), file);
	let error: unknown;
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (validator.check(value)) return { kind: "loaded", value };
		error = new Error(`Invalid ${file}`);
	} catch (caught) {
		if (hasErrorCode(caught, "ENOENT")) return { kind: "missing" };
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

const SessionReceipts = obj(
	{
		version: lit(SESSION_RECEIPTS_VERSION),
		baselineComplete: bool(),
		handledCompletionBySession: map(str()),
	},
	{ open: true },
);
export type SessionReceipts = Static<typeof SessionReceipts>;
const SessionReceiptsFile = compile(SessionReceipts);

export function loadSessionReceipts(): SessionMetadataLoad<SessionReceipts> {
	return loadSessionMetadata("session-receipts.json", SessionReceiptsFile);
}

export function saveSessionReceipts(receipts: SessionReceipts): void {
	writeJsonAtomic("session-receipts.json", receipts);
}

export const SESSION_LIFECYCLE_VERSION = 1;

const PersistedSessionCompletion = obj(
	{ runId: str(), completion: SessionCompletion },
	{ open: true },
);

const SessionLifecycle = obj(
	{
		version: lit(SESSION_LIFECYCLE_VERSION),
		completionBySession: map(PersistedSessionCompletion),
		cancelledRunBySession: map(str()),
	},
	{ open: true },
);
export type SessionLifecycle = Static<typeof SessionLifecycle>;
const SessionLifecycleFile = compile(SessionLifecycle);

export function loadSessionLifecycle(): SessionMetadataLoad<SessionLifecycle> {
	return loadSessionMetadata("session-lifecycle.json", SessionLifecycleFile);
}

export function saveSessionLifecycle(lifecycle: SessionLifecycle): void {
	writeJsonAtomic("session-lifecycle.json", lifecycle);
}

export const TURNS_VERSION = 1;

const PersistedTurns = obj(
	{ version: lit(TURNS_VERSION), byWorkspace: map(arr(TurnChangeSet)) },
	{ open: true },
);
type PersistedTurns = Static<typeof PersistedTurns>;
const PersistedTurnsFile = compile(PersistedTurns);

export function loadTurns(): PersistedTurns {
	const loaded = loadSessionMetadata("turns.json", PersistedTurnsFile);
	return loaded.kind === "loaded" ? loaded.value : { version: TURNS_VERSION, byWorkspace: {} };
}

export function saveTurns(turns: PersistedTurns): void {
	writeJsonAtomic("turns.json", turns);
}

function readStoredList<T>(
	file: string,
	validator: Validator<T>,
	prepare?: (entry: unknown) => unknown,
) {
	const state = openStateFile(file);
	if (Array.isArray(state.value)) {
		return parseEntries(state, prepare ? state.value.map(prepare) : state.value, validator);
	}
	if (state.value !== undefined) state.setAside("not a list");
	return [];
}

const ProjectEntry = compile(Project);
const WorkspaceEntry = compile(Workspace);

function withStoredSlug(entry: unknown): unknown {
	return JsonObject.check(entry) ? { slug: "", ...entry } : entry;
}

export function loadProjects(): Project[] {
	return readStoredList("projects.json", ProjectEntry, withStoredSlug).map((project) => ({
		...project,
		path: storedDirectory(project.path),
	}));
}

export function saveProjects(projects: Project[]): void {
	writeJson("projects.json", projects);
}

export function loadWorkspaces(): Workspace[] {
	return readStoredList("workspaces.json", WorkspaceEntry).map((workspace) => ({
		...workspace,
		worktreePath: storedDirectory(workspace.worktreePath),
	}));
}

export function saveWorkspaces(workspaces: Workspace[]): void {
	writeJson("workspaces.json", workspaces);
}

const PersistedTerminalTab = obj(
	{ tabKey: str(), title: str(), recorded: opt(str()) },
	{ open: true },
);
type PersistedTerminalTab = Static<typeof PersistedTerminalTab>;
const TerminalTabEntry = compile(PersistedTerminalTab);

export type PersistedTerminalSessions = Record<string, PersistedTerminalTab[]>;

export function loadTerminalSessions(): PersistedTerminalSessions {
	const state = openStateFile("terminals.json");
	const sessions: PersistedTerminalSessions = {};
	for (const [workspaceId, tabs] of Object.entries(readStoredObject(state))) {
		if (Array.isArray(tabs)) sessions[workspaceId] = parseEntries(state, tabs, TerminalTabEntry);
		else state.setAside("a workspace entry is not a list");
	}
	return sessions;
}

export function saveTerminalSessions(sessions: PersistedTerminalSessions): void {
	writeJson("terminals.json", sessions);
}

const ModelEntry = compile(WireModel);
const EffortEntry = compile(ThinkingLevel);
const NameEntry = compile(str());
const AgentDirEntry = compile(str({ minLength: 1 }));
const VarEntry = compile(HostEnvironmentVar);

/** A model's identity is `{provider, id}`; the rest is a catalog snapshot older hosts wrote only in part. */
function withModelSnapshot(entry: unknown): unknown {
	if (!JsonObject.check(entry)) return entry;
	return { name: entry.id, contextWindow: 0, reasoning: false, thinkingLevels: [], ...entry };
}

function storedModels(file: StateFile, value: unknown): WireModel[] {
	if (!Array.isArray(value)) return [];
	return parseEntries(file, value.map(withModelSnapshot), ModelEntry);
}

function storedModel(file: StateFile, value: unknown): WireModel | undefined {
	return value === undefined ? undefined : storedModels(file, [value])[0];
}

function storedEffort(file: StateFile, value: unknown): ThinkingLevel | undefined {
	return value === undefined ? undefined : parseEntries(file, [value], EffortEntry)[0];
}

function storedNameList(file: StateFile, value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const names = parseEntries(file, value, NameEntry);
	return [...new Set(names.filter((name) => name.trim().length > 0))];
}

const CONFIG_FIELDS_NOT_KEPT_AS_STORED = [
	"chatMessageOrder",
	"layout",
	"themeMode",
	"systemThemePair",
	"defaultModel",
	"defaultEffort",
	"reviewModel",
	"reviewEffort",
];

export function loadConfig(): AppConfig {
	const state = openStateFile("config.json");
	const value = readStoredObject(state);
	const extensions = { ...value };
	for (const field of CONFIG_FIELDS_NOT_KEPT_AS_STORED) delete extensions[field];
	const defaultModel = storedModel(state, value.defaultModel);
	const defaultEffort = storedEffort(state, value.defaultEffort);
	const reviewModel = storedModel(state, value.reviewModel);
	const reviewEffort = storedEffort(state, value.reviewEffort);
	return {
		...extensions,
		...(defaultModel && { defaultModel }),
		...(defaultEffort && { defaultEffort }),
		...(reviewModel && { reviewModel }),
		...(reviewEffort && { reviewEffort }),
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
		favoriteModels: storedModels(state, value.favoriteModels),
		recentModels: storedModels(state, value.recentModels),
		terminalWindowsShell: isTerminalWindowsShell(value.terminalWindowsShell)
			? value.terminalWindowsShell
			: DEFAULT_CONFIG.terminalWindowsShell,
		settleIdleDays: isSettleIdleDays(value.settleIdleDays)
			? value.settleIdleDays
			: DEFAULT_CONFIG.settleIdleDays,
		disabledExtensions: storedNameList(state, value.disabledExtensions),
		disabledPackages: storedNameList(state, value.disabledPackages),
		locale: isLocalePreference(value.locale) ? value.locale : DEFAULT_CONFIG.locale,
		onboardingDismissed: value.onboardingDismissed === true,
		...normalizeFontSettings(value),
	};
}

export function isConfigOverwriteRefused(): boolean {
	return isOverwriteRefused(join(dataDir(), "config.json"));
}

export function saveConfig(config: AppConfig): void {
	writeJson("config.json", config);
}

export function loadHostEnvironment(): HostEnvironment {
	const state = openStateFile("environment.json");
	const value = readStoredObject(state);
	const vars = Array.isArray(value.vars) ? parseEntries(state, value.vars, VarEntry) : [];
	return {
		...(AgentDirEntry.check(value.agentDir) ? { agentDir: value.agentDir } : {}),
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
