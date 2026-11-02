import {
	type AppConfig,
	type AppConfigUpdate,
	CODE_FONT_SIZE,
	FONT_WEIGHT_OFFSET,
	isCodeFontSize,
	isFontChoice,
	isFontWeightOffset,
	isJbcentralQuotaRefreshSeconds,
	isLineWidth,
	isLocalePreference,
	isSettleIdleDays,
	isSubagentMaxConcurrent,
	LINE_WIDTH_COLUMNS,
	RECENT_MODELS_LIMIT,
	sameModel,
	type WireModel,
} from "@thinkrail/contracts";
import { logger } from "../log";
import {
	didLastConfigReadFail,
	isConfigOverwriteRefused,
	loadConfig,
	saveConfig,
} from "../persistence";
import { normalizeStoredCustomLayoutPresets, validateCustomLayoutPresets } from "./layoutPresets";

const log = logger("settings");

export type SettingsPublisher = (config: AppConfig, appliedUpdate: AppConfigUpdate) => void;
type RuntimeAppConfigUpdate = AppConfigUpdate & {
	chatMessageOrder?: unknown;
	layout?: unknown;
	recentModels?: unknown;
};

const ACCEPTED_UPDATE_KEYS = {
	theme: true,
	themeMode: true,
	systemThemePair: true,
	analyticsEnabled: true,
	analyticsConsentConfirmed: true,
	notificationsEnabled: true,
	terminalReplayKb: true,
	terminalWindowsShell: true,
	composerGrowthLimit: true,
	chatLineWidth: true,
	fileLineWidth: true,
	chatLineWidthBounded: true,
	fileLineWidthBounded: true,
	customLayoutPresets: true,
	favoriteModels: true,
	defaultModel: true,
	defaultEffort: true,
	reviewModel: true,
	reviewEffort: true,
	reviewAutoFix: true,
	agentReviewEnabled: true,
	subagentsEnabled: true,
	subagentMaxConcurrent: true,
	jbcentralQuotaEnabled: true,
	jbcentralQuotaRefreshSeconds: true,
	settleIdleDays: true,
	disabledExtensions: true,
	disabledPackages: true,
	locale: true,
	onboardingDismissed: true,
	interfaceFont: true,
	codeFont: true,
	codeFontSize: true,
	codeLigatures: true,
	fontWeightOffset: true,
	chatMessageOrder: true,
	layout: true,
	recentModels: true,
} satisfies Record<keyof RuntimeAppConfigUpdate, true>;

function assertKnownKeys(update: AppConfigUpdate): void {
	const unknownKey = Object.keys(update).find((key) => !Object.hasOwn(ACCEPTED_UPDATE_KEYS, key));
	if (unknownKey !== undefined) throw new Error(`Unknown setting: ${unknownKey}`);
}

function identifiesModel(model: WireModel): boolean {
	return model.provider.length > 0 && model.id.length > 0;
}

function validateFavoriteModels(value: WireModel[]): WireModel[] {
	if (!value.every(identifiesModel)) {
		throw new Error("favoriteModels must be a list of models");
	}
	return value.filter((model, index) => value.findIndex((m) => sameModel(m, model)) === index);
}

function validateNameList(value: string[], setting: string, noun: string): string[] {
	if (!value.every((name) => name.trim().length > 0)) {
		throw new Error(`${setting} must be a list of ${noun}`);
	}
	return [...new Set(value)];
}

let publishSettings: SettingsPublisher | null = null;

export function setSettingsPublisher(fn: SettingsPublisher | null): void {
	publishSettings = fn;
}

let cached: AppConfig | null = null;
let cacheHoldsDefaultsFromFailedRead = false;

export function getConfig(): AppConfig {
	if (cached) return cached;
	const loaded = loadConfig();
	cacheHoldsDefaultsFromFailedRead = didLastConfigReadFail();
	const customLayoutPresets = normalizeStoredCustomLayoutPresets(loaded.customLayoutPresets);
	cached = { ...loaded, customLayoutPresets };
	if (JSON.stringify(customLayoutPresets) !== JSON.stringify(loaded.customLayoutPresets)) {
		saveConfig(cached);
	}
	return cached;
}

function configToOverwrite(): AppConfig {
	if (cacheHoldsDefaultsFromFailedRead) cached = null;
	else if (cached && isConfigOverwriteRefused()) loadConfig();
	return getConfig();
}

function saveOverCache(next: AppConfig): void {
	saveConfig(next);
	cached = next;
	cacheHoldsDefaultsFromFailedRead = false;
}

/** Whether the live config is defaults from a failed read. Reads again first, so a fixed file reaches every client. */
export function configReadFailed(): boolean {
	getConfig();
	if (!cacheHoldsDefaultsFromFailedRead) return false;
	cached = null;
	const config = getConfig();
	if (cacheHoldsDefaultsFromFailedRead) return true;
	try {
		publishSettings?.(config, {});
	} catch (error) {
		log.warn("recovered config not published", error);
	}
	return false;
}

export function updateConfig(partial: AppConfigUpdate): AppConfig {
	assertKnownKeys(partial);
	const runtimeUpdate: RuntimeAppConfigUpdate = { ...partial };
	delete runtimeUpdate.chatMessageOrder;
	delete runtimeUpdate.layout;
	for (const [name, value] of [
		["chatLineWidth", runtimeUpdate.chatLineWidth],
		["fileLineWidth", runtimeUpdate.fileLineWidth],
	] as const) {
		if (value !== undefined && !isLineWidth(value)) {
			throw new Error(
				`${name} must be a whole number from ${LINE_WIDTH_COLUMNS.min} to ${LINE_WIDTH_COLUMNS.max}`,
			);
		}
	}
	for (const [name, value] of [
		["interfaceFont", runtimeUpdate.interfaceFont],
		["codeFont", runtimeUpdate.codeFont],
	] as const) {
		if (value !== undefined && !isFontChoice(value)) {
			throw new Error(`${name} must be a font family or null plus up to 8 distinct fallbacks`);
		}
	}
	if (runtimeUpdate.codeFontSize !== undefined && !isCodeFontSize(runtimeUpdate.codeFontSize)) {
		throw new Error(
			`codeFontSize must be a whole number from ${CODE_FONT_SIZE.min} to ${CODE_FONT_SIZE.max}`,
		);
	}
	if (
		runtimeUpdate.fontWeightOffset !== undefined &&
		!isFontWeightOffset(runtimeUpdate.fontWeightOffset)
	) {
		throw new Error(
			`fontWeightOffset must be a multiple of ${FONT_WEIGHT_OFFSET.step} from ${FONT_WEIGHT_OFFSET.min} to ${FONT_WEIGHT_OFFSET.max}`,
		);
	}
	if (
		runtimeUpdate.analyticsConsentConfirmed !== undefined &&
		runtimeUpdate.analyticsEnabled === undefined
	) {
		throw new Error("analytics consent must include the sharing preference");
	}
	const {
		defaultModel,
		defaultEffort,
		reviewModel,
		reviewEffort,
		favoriteModels,
		recentModels: _hostOwnedRecentModels,
		customLayoutPresets,
		subagentsEnabled,
		theme,
		themeMode,
		systemThemePair,
		jbcentralQuotaEnabled,
		jbcentralQuotaRefreshSeconds,
		disabledExtensions,
		disabledPackages,
		...rest
	} = runtimeUpdate;
	const nextDisabledExtensions =
		disabledExtensions === undefined
			? undefined
			: validateNameList(disabledExtensions, "disabledExtensions", "extension names");
	const nextDisabledPackages =
		disabledPackages === undefined
			? undefined
			: validateNameList(disabledPackages, "disabledPackages", "package identities");
	for (const [name, value] of [
		["defaultModel", defaultModel],
		["reviewModel", reviewModel],
	] as const) {
		if (value !== undefined && value !== null && !identifiesModel(value)) {
			throw new Error(`${name} must be a model or null`);
		}
	}
	if (
		runtimeUpdate.subagentMaxConcurrent !== undefined &&
		!isSubagentMaxConcurrent(runtimeUpdate.subagentMaxConcurrent)
	) {
		throw new Error("subagentMaxConcurrent must be a whole number from 1 to 16");
	}
	if (
		runtimeUpdate.terminalReplayKb !== undefined &&
		!Number.isFinite(runtimeUpdate.terminalReplayKb)
	) {
		throw new Error("terminalReplayKb must be a finite number");
	}
	if (
		jbcentralQuotaRefreshSeconds !== undefined &&
		!isJbcentralQuotaRefreshSeconds(jbcentralQuotaRefreshSeconds)
	) {
		throw new Error("jbcentralQuotaRefreshSeconds must be a whole number from 1 to 3600");
	}
	if (
		runtimeUpdate.settleIdleDays !== undefined &&
		!isSettleIdleDays(runtimeUpdate.settleIdleDays)
	) {
		throw new Error("settleIdleDays must be a whole number of days from 1 to 365, or null");
	}
	if (runtimeUpdate.locale !== undefined && !isLocalePreference(runtimeUpdate.locale)) {
		throw new Error('locale must be "system" or a canonical BCP-47 language tag');
	}
	const current = configToOverwrite();
	if (
		runtimeUpdate.analyticsEnabled === true &&
		!current.analyticsEnabled &&
		current.analyticsConsentConfirmed &&
		runtimeUpdate.analyticsConsentConfirmed === undefined
	) {
		throw new Error("enabling additional analytics requires an explicit confirmation");
	}
	const nextThemeMode = themeMode ?? (theme !== undefined ? "fixed" : current.themeMode);
	const nextSystemThemePair =
		systemThemePair === undefined
			? current.systemThemePair
			: { light: systemThemePair.light, dark: systemThemePair.dark };
	if (nextThemeMode === "system" && !nextSystemThemePair) {
		throw new Error("system theme mode requires a complete pair");
	}
	const next: AppConfig = {
		...current,
		...rest,
		...(theme === undefined ? {} : { theme }),
		themeMode: nextThemeMode,
		...(nextSystemThemePair ? { systemThemePair: nextSystemThemePair } : {}),
		...(subagentsEnabled === undefined ? {} : { subagentsEnabled }),
		...(jbcentralQuotaEnabled === undefined ? {} : { jbcentralQuotaEnabled }),
		...(jbcentralQuotaRefreshSeconds === undefined ? {} : { jbcentralQuotaRefreshSeconds }),
		...(customLayoutPresets === undefined
			? {}
			: { customLayoutPresets: validateCustomLayoutPresets(customLayoutPresets) }),
		...(favoriteModels === undefined
			? {}
			: { favoriteModels: validateFavoriteModels(favoriteModels) }),
		...(nextDisabledExtensions === undefined ? {} : { disabledExtensions: nextDisabledExtensions }),
		...(nextDisabledPackages === undefined ? {} : { disabledPackages: nextDisabledPackages }),
	};
	if (defaultModel !== undefined) {
		if (defaultModel === null) delete next.defaultModel;
		else next.defaultModel = defaultModel;
	}
	if (defaultEffort !== undefined) {
		if (defaultEffort === null) delete next.defaultEffort;
		else next.defaultEffort = defaultEffort;
	}
	if (reviewModel !== undefined) {
		if (reviewModel === null) delete next.reviewModel;
		else next.reviewModel = reviewModel;
	}
	if (reviewEffort !== undefined) {
		if (reviewEffort === null) delete next.reviewEffort;
		else next.reviewEffort = reviewEffort;
	}
	saveOverCache(next);
	publishSettings?.(next, runtimeUpdate);
	return next;
}

/** Records an explicit model choice at the head of `recentModels` (deduped, capped), then publishes. Best effort: the choice has already applied. */
export function noteRecentModel(model: WireModel): void {
	try {
		const current = configToOverwrite();
		const recentModels = [
			model,
			...current.recentModels.filter((candidate) => !sameModel(candidate, model)),
		].slice(0, RECENT_MODELS_LIMIT);
		const next: AppConfig = { ...current, recentModels };
		saveOverCache(next);
		publishSettings?.(next, {});
	} catch (error) {
		log.warn("recent model not noted", error);
	}
}

export function resetConfigCache(): void {
	cached = null;
	cacheHoldsDefaultsFromFailedRead = false;
}
