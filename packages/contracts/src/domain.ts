import type {
	AppConfig,
	BackgroundCommandSummary,
	ComposerGrowthLimit,
	DelegationRunStatus,
	FontChoice,
	FontFamilyRef,
	FontRole,
	JbcentralStatus,
	PlanReviewVerdict,
	ResourceHistoryCursor,
	ResourceRecord,
	ResourceTally,
	ReviewCommentKind,
	ReviewReadingStep,
	ReviewSnapshot,
	SearchKind,
	SurveyRatingScale,
	SystemThemePair,
	TerminalWindowsShell,
	ThemeMode,
	ThemePreference,
	ThinkingLevel,
	UserFontFace,
	UserFontFile,
	UserFontFileErrorCode,
} from "./schema";

export const FIRST_PROMPT_MAX_LENGTH = 200;

const SKILL_BLOCK = /^\s*<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>\s*/;
const SKILL_COMMAND = /^\s*\/skill:(\S+)[ \t]*/;

export function clampToCodePoints(text: string, maxUnits: number): string {
	if (text.length <= maxUnits) return text;
	const last = text.charCodeAt(maxUnits - 1);
	return text.slice(0, last >= 0xd800 && last <= 0xdbff ? maxUnits - 1 : maxUnits);
}

const PACKAGE_HEADER = /^<[a-z][\w-]*(?:\s[^<>]*)?>$/;
const HEAD_SCAN_LIMIT = FIRST_PROMPT_MAX_LENGTH * 4;

function firstNonBlankLine(text: string): string | undefined {
	let start = 0;
	while (start < text.length) {
		const newline = text.indexOf("\n", start);
		const end = newline === -1 ? text.length : newline;
		const line = text
			.slice(start, Math.min(end, start + HEAD_SCAN_LIMIT))
			.replace(/\s+/g, " ")
			.trim();
		if (line) return line;
		if (newline === -1) break;
		start = newline + 1;
	}
	return undefined;
}

export function firstPromptHead(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const skill = SKILL_BLOCK.exec(text) ?? SKILL_COMMAND.exec(text);
	const body = skill ? text.slice(skill[0].length) || `/skill:${skill[1]}` : text;
	const line = firstNonBlankLine(body);
	if (!line || PACKAGE_HEADER.test(line)) return undefined;
	return clampToCodePoints(line, FIRST_PROMPT_MAX_LENGTH);
}

export function firstPromptOfTexts(texts: Iterable<string>): string | undefined {
	for (const text of texts) {
		if (isControlMessage(text)) continue;
		const head = firstPromptHead(text);
		if (head) return head;
	}
	return undefined;
}

export const DEFAULT_WORKSPACE_NAME = "Default";

export type WorkspaceSkillChange = "none" | "detected" | "unknown";

export interface WorkspaceFsChangedPayload {
	workspaceId: string;
	paths: string[];
	truncated: boolean;
	skillChange: WorkspaceSkillChange;
}

const THINKING_LEVEL_SET = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
} satisfies Record<ThinkingLevel, true>;

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && Object.hasOwn(THINKING_LEVEL_SET, value);
}

const DELEGATION_RUN_STATUSES: readonly string[] = [
	"queued",
	"running",
	"completed",
	"error",
	"aborted",
];

export function isDelegationRunDetails(value: unknown): value is DelegationRunDetails {
	if (!value || typeof value !== "object") return false;
	const d = value as Partial<DelegationRunDetails>;
	if (typeof d.childSessionId !== "string" || typeof d.task !== "string") return false;
	if (typeof d.status !== "string" || !DELEGATION_RUN_STATUSES.includes(d.status)) return false;
	if (typeof d.durationMs !== "number") return false;
	for (const field of [d.roleName, d.roleSource, d.model, d.activity, d.abortReason]) {
		if (field !== undefined && typeof field !== "string") return false;
	}
	if (d.thinkingLevel !== undefined && !isThinkingLevel(d.thinkingLevel)) return false;
	const u = d.usage as Partial<DelegationRunDetails["usage"]> | undefined;
	return (
		!!u &&
		typeof u === "object" &&
		typeof u.input === "number" &&
		typeof u.output === "number" &&
		typeof u.cacheRead === "number" &&
		typeof u.cacheWrite === "number" &&
		typeof u.cost === "number" &&
		typeof u.turns === "number" &&
		typeof u.contextTokens === "number"
	);
}

export interface DelegationRunDetails {
	childSessionId: string;
	roleName?: string;
	roleSource?: string;
	task: string;
	status: DelegationRunStatus;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		turns: number;
		contextTokens: number;
	};
	durationMs: number;
	activity?: string;
	abortReason?: string;
}

export type CompletionDelivery = "wake" | "run" | "appended";

export interface SubagentCompletionDetails extends DelegationRunDetails {
	delivery?: CompletionDelivery;
}

export interface BackgroundCommandCompletionDetails
	extends Omit<BackgroundCommandSummary, "command"> {
	status: "completed" | "error" | "stopped";
	finishedAt: number;
	output: { text: string; truncated: boolean };
	delivery?: CompletionDelivery;
}

export type ResourceOutcome = keyof ResourceTally;

export const RESOURCE_HISTORY_PAGE_LIMIT = 20;
export const RESOURCE_HISTORY_MAX_PAGE_LIMIT = 100;

export function resourceRecordId(record: ResourceRecord): string {
	return record.kind === "command" ? record.summary.id : record.summary.childSessionId;
}

function hasLiveStatus(record: ResourceRecord): boolean {
	const { status } = record.summary;
	return record.kind === "command"
		? status === "running" || status === "stopping"
		: status === "queued" || status === "running";
}

export function isLiveResource(record: ResourceRecord): boolean {
	return !record.summary.interrupted && hasLiveStatus(record);
}

export function interruptedResource(record: ResourceRecord): ResourceRecord {
	return record.kind === "command"
		? {
				kind: "command",
				summary: {
					...record.summary,
					status: hasLiveStatus(record) ? "stopped" : record.summary.status,
					interrupted: true,
				},
			}
		: {
				kind: "subagent",
				summary: {
					...record.summary,
					status: hasLiveStatus(record) ? "aborted" : record.summary.status,
					interrupted: true,
				},
			};
}

export function resourceOutcome(record: ResourceRecord): ResourceOutcome | null {
	if (record.summary.interrupted) return "interrupted";
	if (record.kind === "command") {
		switch (record.summary.status) {
			case "completed":
				return record.summary.exitCode === 0 ? "done" : "failed";
			case "error":
				return "failed";
			case "stopped":
				return "stopped";
			default:
				return null;
		}
	}
	switch (record.summary.status) {
		case "completed":
			return "done";
		case "error":
			return "failed";
		case "aborted":
			return "stopped";
		default:
			return null;
	}
}

function emptyResourceTally(): ResourceTally {
	return { done: 0, failed: 0, stopped: 0, interrupted: 0 };
}

export function tallyResources(records: readonly ResourceRecord[]): ResourceTally {
	const tally = emptyResourceTally();
	for (const record of records) {
		const outcome = resourceOutcome(record);
		if (outcome) tally[outcome]++;
	}
	return tally;
}

export function resourceTallyTotal(tally: ResourceTally): number {
	return tally.done + tally.failed + tally.stopped + tally.interrupted;
}

export function resourceHistoryCursor(record: ResourceRecord): ResourceHistoryCursor {
	const at =
		record.summary.finishedAt ??
		(record.kind === "command" ? record.summary.startedAt : Date.parse(record.summary.createdAt));
	return { at: Number.isFinite(at) ? at : 0, id: resourceRecordId(record) };
}

export function compareResourceHistory(a: ResourceHistoryCursor, b: ResourceHistoryCursor): number {
	return b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** Mirror of pi's `McpToolDetails` as it arrives in `mcp__*` and the three MCP resource tools' results. */
export interface McpToolDetails {
	server: string;
	tool: string;
	fullOutputPath?: string;
}

export type McpContentBlockSummary =
	| { kind: "text"; chars: number }
	| { kind: "image"; mimeType: string }
	| { kind: "audio"; mimeType: string }
	| { kind: "resource_link"; uri: string; name?: string; mimeType?: string }
	| { kind: "resource"; uri: string; mimeType?: string; chars?: number };

/**
 * Bounded, base64-free presentation summary written into a tool result's `details.thinkrail` by the
 * host so cards render the same live, after reload, and on another client.
 */
export interface McpResultSummary {
	blocks: McpContentBlockSummary[];
	/** Blocks dropped from the end of `blocks` once the summary's byte budget was spent. */
	omittedBlocks?: number;
	structuredContent?: unknown;
	structuredContentTruncated?: boolean;
	isError?: boolean;
}

const NPM_NAME = String.raw`(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*`;
const BARE_NPM_SPEC = new RegExp(`^(${NPM_NAME})(?:@([^/\\s@]+))?$`, "i");
const EXTENSION_FILE = /\.(m|c)?(j|t)sx?$/i;
const PI_INSTALL_COMMAND = /^pi\s+install\b/;
const PI_INSTALL_LOCAL_FLAGS = new Set(["-l", "--local"]);

export interface PiPackageInput {
	/** The source string pi accepts, or "" when the input names nothing. */
	source: string;
	/** `true` when a pasted `pi install` line carried `-l` / `--local`. */
	local: boolean;
	/** The bare name `source` was inferred from (`bigpowers` → `npm:bigpowers`); absent otherwise. */
	bareName?: string;
}

/**
 * The install field's forgiving forms, reduced to what pi accepts: a pasted `pi install …` line (its
 * `-l` is reported, not dropped), a pi.dev or npmjs.com package URL and a bare npm name become `npm:…`;
 * everything else — `npm:` / `git:` sources, git URLs, paths — is returned trimmed. Never throws.
 */
export function parsePiPackageInput(raw: string): PiPackageInput {
	let source = unwrapQuotes(raw.trim());
	let local = false;
	if (PI_INSTALL_COMMAND.test(source)) {
		const words = shellWords(source).slice(2);
		local = words.some((word) => PI_INSTALL_LOCAL_FLAGS.has(word));
		const sources = words.filter((word) => !word.startsWith("-"));
		source = sources.length === 1 ? (sources[0] ?? "") : "";
	}
	const fromUrl = packageUrlSource(source);
	if (fromUrl !== null) return { source: fromUrl, local };
	if (
		BARE_NPM_SPEC.test(source) &&
		!EXTENSION_FILE.test(source) &&
		!/^(npm|git|builtin|file):/i.test(source)
	) {
		return { source: `npm:${source}`, local, bareName: source };
	}
	return { source, local };
}

/** Strips one balanced pair of surrounding quotes or backticks — a pasted `\`pi install …\`` or `"npm:x"`. */
function unwrapQuotes(text: string): string {
	const first = text[0];
	if (first && "`'\"".includes(first) && text.length >= 2 && text.endsWith(first)) {
		return text.slice(1, -1).trim();
	}
	return text;
}

/** Shell-style words: quotes group, a backslash escapes the next character (inside double quotes only `\"` / `\\`). */
function shellWords(text: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: string | null = null;
	let inWord = false;
	const chars = [...text];
	for (let i = 0; i < chars.length; i += 1) {
		const char = chars[i] ?? "";
		if (quote === "'") {
			if (char === "'") quote = null;
			else current += char;
			continue;
		}
		if (
			char === "\\" &&
			i + 1 < chars.length &&
			(quote === null || /["\\]/.test(chars[i + 1] ?? ""))
		) {
			current += chars[i + 1];
			inWord = true;
			i += 1;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = null;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			inWord = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (inWord) words.push(current);
			current = "";
			inWord = false;
			continue;
		}
		current += char;
		inWord = true;
	}
	if (inWord) words.push(current);
	return words;
}

function packageUrlSource(source: string): string | null {
	if (!/^https?:\/\//i.test(source)) return null;
	let url: URL;
	try {
		url = new URL(source);
	} catch {
		return source;
	}
	const host = url.hostname.replace(/^www\./, "");
	if (host !== "pi.dev" && host !== "npmjs.com") return source;
	let path: string;
	try {
		path = decodeURIComponent(url.pathname).replace(/\/+$/, "");
	} catch {
		return source;
	}
	const piDev = host === "pi.dev" ? path.match(/^\/packages\/(.+)$/) : null;
	if (piDev?.[1]) return `npm:${piDev[1]}`;
	const npmjs = host === "npmjs.com" ? path.match(/^\/package\/(.+?)(?:\/v\/([^/]+))?$/) : null;
	if (npmjs?.[1]) return `npm:${npmjs[1]}${npmjs[2] ? `@${npmjs[2]}` : ""}`;
	return source;
}

export function isJbcentralConnected(status: JbcentralStatus): boolean {
	return status.state === "configured" && !status.signedOut && !status.proxyStopped;
}

export type LoginFrame =
	| { kind: "authUrl"; url: string; instructions?: string }
	| { kind: "deviceCode"; userCode: string; verificationUri: string; expiresInSeconds?: number }
	| { kind: "select"; message: string; options: { id: string; label: string }[] }
	| {
			kind: "prompt";
			message: string;
			placeholder?: string;
			allowEmpty?: boolean;
			secret?: boolean;
	  }
	| { kind: "progress"; message: string }
	| { kind: "success" }
	| { kind: "error"; message: string };

export interface LoginPush {
	loginId: string;
	providerId: string;
	frame: LoginFrame;
	/** Present for MCP server sign-ins; such pushes reach only the connection that started the login. */
	target?: { kind: "mcp"; workspaceId: string; serverName: string };
}

export type ThemeId = string;

export const THEME_MODES = ["fixed", "system"] as const satisfies readonly ThemeMode[];

export function isThemeMode(value: unknown): value is ThemeMode {
	return THEME_MODES.some((mode) => mode === value);
}

export function isSystemThemePair(value: unknown): value is SystemThemePair {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof Reflect.get(value, "light") === "string" &&
		typeof Reflect.get(value, "dark") === "string"
	);
}

export const FONT_ROLES = ["interface", "code"] as const satisfies readonly FontRole[];

export const FONT_FAMILY_NAME_MAX_LENGTH = 128;
export const FONT_FALLBACKS_MAX = 8;
/** `editorDelta`: the editor and diffs render this many px below the code size. */
export const CODE_FONT_SIZE = { min: 10, max: 24, default: 13, editorDelta: 2 } as const;
export const FONT_WEIGHT_OFFSET = { min: -70, max: 130, step: 10, default: 0 } as const;

const FONT_NAME_DELIMITERS = /["\\;{}]/;

export function hasControlCharacter(text: string): boolean {
	return [...text].some((char) => {
		const code = char.codePointAt(0) ?? 0;
		return code < 0x20 || code === 0x7f;
	});
}

export function isFontFamilyName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= FONT_FAMILY_NAME_MAX_LENGTH &&
		value.trim() === value &&
		!FONT_NAME_DELIMITERS.test(value) &&
		!hasControlCharacter(value)
	);
}

export function isFontRole(value: unknown): value is FontRole {
	return FONT_ROLES.some((role) => role === value);
}

export function isFontFamilyRef(value: unknown): value is FontFamilyRef {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const keys = Object.keys(value);
	if (keys.length !== 1) return false;
	if (keys[0] === "builtin") return isFontRole(Reflect.get(value, "builtin"));
	return keys[0] === "name" && isFontFamilyName(Reflect.get(value, "name"));
}

export function fontFamilyRefKey(ref: FontFamilyRef): string {
	return "builtin" in ref ? `builtin:${ref.builtin}` : `name:${ref.name}`;
}

export function isFontChoice(value: unknown): value is FontChoice {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const family = Reflect.get(value, "family");
	const fallbacks = Reflect.get(value, "fallbacks");
	return (
		(family === null || isFontFamilyRef(family)) &&
		Array.isArray(fallbacks) &&
		fallbacks.length <= FONT_FALLBACKS_MAX &&
		fallbacks.every(isFontFamilyRef) &&
		new Set(fallbacks.map(fontFamilyRefKey)).size === fallbacks.length
	);
}

export function isCodeFontSize(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= CODE_FONT_SIZE.min &&
		value <= CODE_FONT_SIZE.max
	);
}

export function isFontWeightOffset(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= FONT_WEIGHT_OFFSET.min &&
		value <= FONT_WEIGHT_OFFSET.max &&
		value % FONT_WEIGHT_OFFSET.step === 0
	);
}

export const COMPOSER_GROWTH_LIMITS = [
	"compact",
	"roomy",
	"half-chat",
] as const satisfies readonly ComposerGrowthLimit[];

export function isComposerGrowthLimit(value: unknown): value is ComposerGrowthLimit {
	return COMPOSER_GROWTH_LIMITS.some((limit) => limit === value);
}

export const LINE_WIDTH_COLUMNS = { min: 40, max: 240, default: 120 } as const;

export function isLineWidth(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= LINE_WIDTH_COLUMNS.min &&
		value <= LINE_WIDTH_COLUMNS.max
	);
}

/** How many recently chosen models the host remembers. */
export const RECENT_MODELS_LIMIT = 5;

export interface GithubStarAsk {
	stars: number | null;
}

export const SURVEY_OPEN_TEXT_LIMIT = 2000;

export function surveyRatingValues(scale: SurveyRatingScale): number[] {
	if (scale === 10) return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
	return Array.from({ length: scale }, (_, index) => index + 1);
}

export const TERMINAL_REPLAY_KB = { min: 0, max: 1024, default: 64 } as const;

export const TERMINAL_WINDOWS_SHELLS = [
	"auto",
	"pwsh",
	"powershell",
	"cmd",
] as const satisfies readonly TerminalWindowsShell[];

export function isTerminalWindowsShell(value: unknown): value is TerminalWindowsShell {
	return TERMINAL_WINDOWS_SHELLS.some((shell) => shell === value);
}

export const SETTLE_IDLE_DAYS = { min: 1, max: 365, default: 7 } as const;

export function isSettleIdleDays(value: unknown): value is number | null {
	return (
		value === null ||
		(typeof value === "number" &&
			Number.isInteger(value) &&
			value >= SETTLE_IDLE_DAYS.min &&
			value <= SETTLE_IDLE_DAYS.max)
	);
}

export const SYSTEM_LOCALE_PREFERENCE = "system";

export function isLocalePreference(value: unknown): value is string {
	if (value === SYSTEM_LOCALE_PREFERENCE) return true;
	if (typeof value !== "string" || value.length === 0 || value.length > 35) return false;
	try {
		return Intl.getCanonicalLocales(value)[0] === value;
	} catch {
		return false;
	}
}

const USER_FONT_FILE_ERROR_CODES = [
	"too-large",
	"too-many",
	"unsupported-collection",
	"invalid-font",
	"unreadable",
] as const satisfies readonly UserFontFileErrorCode[];

function isUserFontFace(value: unknown): value is UserFontFace {
	if (typeof value !== "object" || value === null) return false;
	const weight = Reflect.get(value, "weight");
	const style = Reflect.get(value, "style");
	if (typeof weight !== "object" || weight === null) return false;
	const min = Reflect.get(weight, "min");
	const max = Reflect.get(weight, "max");
	return (
		isFontFamilyName(Reflect.get(value, "family")) &&
		(style === "normal" || style === "italic") &&
		typeof min === "number" &&
		typeof max === "number" &&
		min <= max &&
		typeof Reflect.get(value, "monospace") === "boolean"
	);
}

/** The shape `fonts.list` and a `/fonts/` upload report for one file. */
export function isUserFontFile(value: unknown): value is UserFontFile {
	if (typeof value !== "object" || value === null) return false;
	if (typeof Reflect.get(value, "fileName") !== "string") return false;
	const ok = Reflect.get(value, "ok");
	if (ok === true) {
		return (
			typeof Reflect.get(value, "url") === "string" && isUserFontFace(Reflect.get(value, "face"))
		);
	}
	const error = Reflect.get(value, "error");
	return ok === false && USER_FONT_FILE_ERROR_CODES.some((code) => code === error);
}

/** Serves (`GET`) and accepts (`PUT`) user font files by base name. */
export const USER_FONTS_ROUTE = "/fonts/";
/** Required on `PUT` uploads: a non-simple header forces a CORS preflight the host never answers. */
export const USER_FONT_UPLOAD_HEADER = {
	name: "X-ThinkRail-Request",
	value: "font-upload",
} as const;
export const USER_FONT_EXTENSIONS = [".ttf", ".otf", ".woff", ".woff2"] as const;

export const SUBAGENT_MAX_CONCURRENT = { min: 1, max: 16, default: 4 } as const;

export function isSubagentMaxConcurrent(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= SUBAGENT_MAX_CONCURRENT.min &&
		value <= SUBAGENT_MAX_CONCURRENT.max
	);
}

export const JBCENTRAL_QUOTA_REFRESH_SECONDS = { min: 1, max: 3600, default: 30 } as const;

export function isJbcentralQuotaRefreshSeconds(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= JBCENTRAL_QUOTA_REFRESH_SECONDS.min &&
		value <= JBCENTRAL_QUOTA_REFRESH_SECONDS.max
	);
}

export const DEFAULT_CONFIG: AppConfig = {
	theme: "dark",
	themeMode: "fixed",
	analyticsEnabled: false,
	analyticsConsentConfirmed: false,
	notificationsEnabled: true,
	terminalReplayKb: TERMINAL_REPLAY_KB.default,
	terminalWindowsShell: "auto",
	composerGrowthLimit: "half-chat",
	chatLineWidth: LINE_WIDTH_COLUMNS.default,
	fileLineWidth: LINE_WIDTH_COLUMNS.default,
	chatLineWidthBounded: true,
	fileLineWidthBounded: true,
	voiceInputEnabled: true,
	customLayoutPresets: [],
	favoriteModels: [],
	recentModels: [],
	reviewAutoFix: false,
	agentReviewEnabled: false,
	subagentsEnabled: true,
	subagentMaxConcurrent: SUBAGENT_MAX_CONCURRENT.default,
	jbcentralQuotaEnabled: true,
	jbcentralQuotaRefreshSeconds: JBCENTRAL_QUOTA_REFRESH_SECONDS.default,
	settleIdleDays: SETTLE_IDLE_DAYS.default,
	disabledExtensions: [],
	extensionSettings: {},
	disabledPackages: [],
	locale: SYSTEM_LOCALE_PREFERENCE,
	onboardingDismissed: false,
	interfaceFont: { family: null, fallbacks: [] },
	codeFont: { family: null, fallbacks: [] },
	codeFontSize: CODE_FONT_SIZE.default,
	codeLigatures: false,
	fontWeightOffset: FONT_WEIGHT_OFFSET.default,
};

export type FontSettings = Pick<
	AppConfig,
	"interfaceFont" | "codeFont" | "codeFontSize" | "codeLigatures" | "fontWeightOffset"
>;

/** Each font field independently: a malformed one falls back to its own default. */
export function normalizeFontSettings(value: unknown): FontSettings {
	const record = typeof value === "object" && value !== null ? value : {};
	const interfaceFont = Reflect.get(record, "interfaceFont");
	const codeFont = Reflect.get(record, "codeFont");
	const codeFontSize = Reflect.get(record, "codeFontSize");
	const codeLigatures = Reflect.get(record, "codeLigatures");
	const fontWeightOffset = Reflect.get(record, "fontWeightOffset");
	return {
		interfaceFont: isFontChoice(interfaceFont) ? interfaceFont : DEFAULT_CONFIG.interfaceFont,
		codeFont: isFontChoice(codeFont) ? codeFont : DEFAULT_CONFIG.codeFont,
		codeFontSize: isCodeFontSize(codeFontSize) ? codeFontSize : DEFAULT_CONFIG.codeFontSize,
		codeLigatures:
			typeof codeLigatures === "boolean" ? codeLigatures : DEFAULT_CONFIG.codeLigatures,
		fontWeightOffset: isFontWeightOffset(fontWeightOffset)
			? fontWeightOffset
			: DEFAULT_CONFIG.fontWeightOffset,
	};
}

export function normalizeThemePreference(value: unknown): ThemePreference {
	const record = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
	const rawTheme = Reflect.get(record, "theme");
	const rawMode = Reflect.get(record, "themeMode");
	const rawPair = Reflect.get(record, "systemThemePair");
	const systemThemePair = isSystemThemePair(rawPair)
		? { light: rawPair.light, dark: rawPair.dark }
		: undefined;
	const themeMode =
		isThemeMode(rawMode) && (rawMode === "fixed" || systemThemePair)
			? rawMode
			: DEFAULT_CONFIG.themeMode;
	return {
		theme: typeof rawTheme === "string" ? rawTheme : DEFAULT_CONFIG.theme,
		themeMode,
		...(systemThemePair ? { systemThemePair } : {}),
	};
}

export const TODO_NUDGE_PREFIX = "[thinkrail:todo-nudge] ";

export function isControlMessage(text: string): boolean {
	return text.startsWith(TODO_NUDGE_PREFIX);
}

export const IMAGE_MAX_BASE64_BYTES = 4.5 * 1024 * 1024;

export function base64EncodedLength(byteLength: number): number {
	return Math.ceil(byteLength / 3) * 4;
}

export const ACCEPTED_IMAGE_TYPES: readonly string[] = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
];

export const REQUEST_IMAGE_BASE64_BUDGET = 24 * 1024 * 1024;

export function isRetriedAttempt(
	messages: readonly { role: string; stopReason?: string }[],
	index: number,
): boolean {
	const message = messages[index];
	if (message?.role !== "assistant" || message.stopReason !== "error") return false;
	return messages[index + 1]?.role === "assistant";
}

export const MAX_HISTORY_LIMIT = 200;

export const MAX_HISTORY_QUERY_LENGTH = 200;

export const SEARCH_KINDS = [
	"transcript",
	"file",
	"spec",
	"plan",
] as const satisfies readonly SearchKind[];

export const MAX_SEARCH_QUERY_LENGTH = 200;

export const MAX_SEARCH_GROUP_LIMIT = 50;

export const MAX_SEARCH_PREVIEW_BYTES = 2 * 1024 * 1024;

export interface ReviewChangedPayload extends ReviewSnapshot {
	workspaceId: string;
}

/** A plan review that failed after `todo.startReview` acknowledged — the detached button/auto path has no
 * chat of its own, so the owning plan session raises the failure as a toast. `sessionId` routes it to that
 * plan only; duplicate views of one session dedupe on the toast body. See apps/web/src/panels/SPEC.md. */
export interface ReviewFailedPayload {
	workspaceId: string;
	sessionId: string;
	itemId: string;
	itemTitle: string;
	message: string;
}

/** Slim view of a sent review finding on a todo-review-fix message (path/lines pre-resolved host-side). */
export interface ReviewFixComment {
	id: string;
	kind: ReviewCommentKind;
	body: string;
	path?: string;
	startLine?: number;
	endLine?: number;
}

/** Structured payload of a todo-review-fix custom message; the message `content` stays the agent-read text. */
export interface ReviewFixDetails {
	itemId: string;
	itemTitle: string;
	reviewId?: string;
	/** The reviewer's/user's feedback prose (renderFixPackage note), when present. */
	note?: string;
	comments: ReviewFixComment[];
}

/** Result of the worker-invoked request_review tool (Option A): a review subagent's structured verdict on
 * a plan step. Carried as the tool result's `details`, rendered by the request_review card, and written to
 * the item's review record. See submodule-server-host-plan-review + submodule-server-todos. */
export interface PlanReviewResult {
	itemId: string;
	itemTitle: string;
	verdict: PlanReviewVerdict;
	reviewedSha?: string;
	/** The reviewer's one-paragraph rationale (shown on the card). */
	summary?: string;
	/** The reviewer's suggested order for reading the change set, one line of why per file. */
	readingOrder?: ReviewReadingStep[];
	findings: ReviewFixComment[];
	/** Host-set on an `approve` it refused to settle: findings from an earlier round are still open, so
	 * the step stays unreviewed until the worker resolves them. */
	blockedByOpenFindings?: number;
}

export const PLAN_REVIEW_VERDICTS: readonly PlanReviewVerdict[] = ["approve", "request_changes"];
export const REVIEW_READING_ORDER_LIMIT = 12;

function isReadingStep(value: unknown): value is ReviewReadingStep {
	if (!value || typeof value !== "object") return false;
	const step = value as Partial<ReviewReadingStep>;
	return (
		typeof step.path === "string" &&
		step.path.length > 0 &&
		typeof step.why === "string" &&
		step.why.length > 0
	);
}

const REVIEW_COMMENT_KINDS: readonly ReviewCommentKind[] = ["inline", "diff", "file", "review"];

function isPositiveInt(n: unknown): n is number {
	return typeof n === "number" && Number.isInteger(n) && n > 0;
}

/** A single reviewer finding: id + body required; kind (if present) a known enum; a line requires a path,
 * an endLine requires a startLine, and any range is positive and coherent. See submodule-server-host-plan-review. */
function isReviewFinding(f: unknown): f is ReviewFixComment {
	if (!f || typeof f !== "object") return false;
	const c = f as Partial<ReviewFixComment>;
	if (typeof c.id !== "string" || c.id.length === 0) return false;
	if (typeof c.body !== "string" || c.body.length === 0) return false;
	if (c.kind !== undefined && !REVIEW_COMMENT_KINDS.includes(c.kind)) return false;
	if (c.path !== undefined && typeof c.path !== "string") return false;
	if (c.startLine !== undefined && !isPositiveInt(c.startLine)) return false;
	if (c.endLine !== undefined && !isPositiveInt(c.endLine)) return false;
	if (c.startLine !== undefined && c.path === undefined) return false;
	if (c.endLine !== undefined && c.startLine === undefined) return false;
	if (c.startLine !== undefined && c.endLine !== undefined && c.endLine < c.startLine) return false;
	return true;
}

/** Validate the review subagent's parsed JSON verdict (untrusted — model output). Every finding field and
 * its enum/line coherence is checked, and the verdict/finding cardinality is enforced: a `request_changes`
 * with no actionable finding is rejected (it would strand the worker), while an `approve` may carry none. */
export function isPlanReviewResult(value: unknown): value is PlanReviewResult {
	if (!value || typeof value !== "object") return false;
	const r = value as Partial<PlanReviewResult>;
	if (typeof r.itemId !== "string" || typeof r.itemTitle !== "string") return false;
	if (typeof r.verdict !== "string" || !PLAN_REVIEW_VERDICTS.includes(r.verdict)) return false;
	if (r.summary !== undefined && typeof r.summary !== "string") return false;
	if (
		r.readingOrder !== undefined &&
		(!Array.isArray(r.readingOrder) ||
			r.readingOrder.length > REVIEW_READING_ORDER_LIMIT ||
			!r.readingOrder.every(isReadingStep))
	) {
		return false;
	}
	if (r.blockedByOpenFindings !== undefined && typeof r.blockedByOpenFindings !== "number")
		return false;
	if (!Array.isArray(r.findings)) return false;
	if (!r.findings.every(isReviewFinding)) return false;
	if (r.verdict === "request_changes" && r.findings.length === 0) return false;
	return true;
}
