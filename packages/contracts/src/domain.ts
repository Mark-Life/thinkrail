import { compile } from "@earendil-works/pi-schema";
import { keepValidFields } from "./fieldwise";
import {
	type AppConfig,
	BackgroundCommandOutputDetails,
	CODE_FONT_SIZE,
	CodeFontSize,
	DelegationRunDetails,
	FONT_WEIGHT_OFFSET,
	FontChoice,
	FontFamilyName,
	FontFamilyRef,
	FontWeightOffset,
	JBCENTRAL_QUOTA_REFRESH_SECONDS,
	JbcentralQuotaRefreshSeconds,
	type JbcentralStatus,
	JsonObject,
	LINE_WIDTH_COLUMNS,
	LineWidth,
	McpContentBlockSummary,
	PartialAppConfig,
	PlanReviewResult,
	type ResourceHistoryCursor,
	type ResourceRecord,
	type ResourceTally,
	SETTLE_IDLE_DAYS,
	SettleIdleDays,
	SUBAGENT_MAX_CONCURRENT,
	SubagentMaxConcurrent,
	type SurveyRatingScale,
	type SystemThemePair,
	TERMINAL_REPLAY_KB,
	THEME_MODES,
	type ThemeMode,
	type ThemePreference,
	UserFontFile,
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

export const isDelegationRunDetails = compile(DelegationRunDetails).check;
export const isBackgroundCommandOutputDetails = compile(BackgroundCommandOutputDetails).check;
export const isMcpContentBlockSummary = compile(McpContentBlockSummary).check;

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

export type ThemeId = string;

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

export function hasControlCharacter(text: string): boolean {
	return [...text].some((char) => {
		const code = char.codePointAt(0) ?? 0;
		return code < 0x20 || code === 0x7f;
	});
}

export const isFontFamilyName = compile(FontFamilyName).check;
export const isFontFamilyRef = compile(FontFamilyRef).check;

export function fontFamilyRefKey(ref: FontFamilyRef): string {
	return "builtin" in ref ? `builtin:${ref.builtin}` : `name:${ref.name}`;
}

export const isFontChoice = compile(FontChoice).check;
export const isCodeFontSize = compile(CodeFontSize).check;
export const isFontWeightOffset = compile(FontWeightOffset).check;

export const isLineWidth = compile(LineWidth).check;

/** How many recently chosen models the host remembers. */
export const RECENT_MODELS_LIMIT = 5;

export const OTHER_AGENT_SKILL_GROUPS: readonly string[] = ["personal", "@plugins"];

/** Bounds of the host's per-request skill listing budget; a larger catalog is listed in part. */
export const SKILL_LISTING_MIN_TOKENS = 4_000;
export const SKILL_LISTING_MAX_TOKENS = 8_000;

export function isSkillGroupEnabled(
	project: { disabledGroups?: readonly string[]; enabledGroups?: readonly string[] } | undefined,
	group: string,
	otherAgentSkills: boolean,
): boolean {
	if (project?.enabledGroups?.includes(group)) return true;
	if (project?.disabledGroups?.includes(group)) return false;
	return otherAgentSkills || !OTHER_AGENT_SKILL_GROUPS.includes(group);
}

export const SURVEY_OPEN_TEXT_LIMIT = 2000;

export function surveyRatingValues(scale: SurveyRatingScale): number[] {
	if (scale === 10) return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
	return Array.from({ length: scale }, (_, index) => index + 1);
}

export const isSettleIdleDays = compile(SettleIdleDays).check;

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

const UserFontFileShape = compile(UserFontFile);

/** One file as `fonts.list` or a `/fonts/` upload reports it, with its weight range in order; `null` when it fails. */
export function parseUserFontFile(value: unknown) {
	if (!UserFontFileShape.check(value)) return null;
	if (value.ok && value.face.weight.min > value.face.weight.max) return null;
	return value;
}

/** Serves (`GET`) and accepts (`PUT`) user font files by base name. */
export const USER_FONTS_ROUTE = "/fonts/";
/** Required on `PUT` uploads: a non-simple header forces a CORS preflight the host never answers. */
export const USER_FONT_UPLOAD_HEADER = {
	name: "X-ThinkRail-Request",
	value: "font-upload",
} as const;
export const USER_FONT_EXTENSIONS = [".ttf", ".otf", ".woff", ".woff2"] as const;

export const isSubagentMaxConcurrent = compile(SubagentMaxConcurrent).check;
export const isJbcentralQuotaRefreshSeconds = compile(JbcentralQuotaRefreshSeconds).check;

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
	otherAgentSkills: false,
	disabledPackages: [],
	locale: SYSTEM_LOCALE_PREFERENCE,
	onboardingDismissed: false,
	interfaceFont: { family: null, fallbacks: [] },
	codeFont: { family: null, fallbacks: [] },
	codeFontSize: CODE_FONT_SIZE.default,
	codeLigatures: false,
	fontWeightOffset: FONT_WEIGHT_OFFSET.default,
};

const PartialAppConfigFields = compile(PartialAppConfig);

/** The fields of a config from a file or a host of any version that pass on their own. */
export function parseAppConfigFields(value: unknown) {
	return keepValidFields(value, PartialAppConfigFields);
}

export type FontSettings = Pick<
	AppConfig,
	"interfaceFont" | "codeFont" | "codeFontSize" | "codeLigatures" | "fontWeightOffset"
>;

/** Each font field independently: a malformed one falls back to its own default. */
export function normalizeFontSettings(value: unknown): FontSettings {
	const record = JsonObject.check(value) ? value : {};
	const { interfaceFont, codeFont, codeFontSize, codeLigatures, fontWeightOffset } = record;
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
	const rawTheme: unknown = Reflect.get(record, "theme");
	const rawMode: unknown = Reflect.get(record, "themeMode");
	const rawPair: unknown = Reflect.get(record, "systemThemePair");
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

export const MAX_SEARCH_QUERY_LENGTH = 200;

export const MAX_SEARCH_GROUP_LIMIT = 50;

export const MAX_SEARCH_PREVIEW_BYTES = 2 * 1024 * 1024;

export const REVIEW_READING_ORDER_LIMIT = 12;

export const isPlanReviewResult = compile(PlanReviewResult).check;
