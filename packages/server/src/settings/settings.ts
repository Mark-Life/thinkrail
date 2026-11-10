import {
	type AppConfig,
	type AppConfigUpdate,
	DROPPED_UPDATE_KEYS,
	type ExtensionSettingValues,
	isLocalePreference,
	RECENT_MODELS_LIMIT,
	sameModel,
	type WireModel,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { logger } from "../log";
import {
	didLastConfigReadFail,
	isConfigOverwriteRefused,
	loadConfig,
	saveConfig,
	setConfigAside,
} from "../persistence";
import { keepValidStoredPresets, validateCustomLayoutPresets } from "./layoutPresets";

const log = logger("settings");

export type SettingsPublisher = (config: AppConfig, appliedUpdate: AppConfigUpdate) => void;
type RuntimeAppConfigUpdate = AppConfigUpdate &
	Partial<Record<(typeof DROPPED_UPDATE_KEYS)[number], unknown>>;

function withoutRepeats(models: WireModel[]): WireModel[] {
	return models.filter((model, index) => models.findIndex((m) => sameModel(m, model)) === index);
}

function mergeExtensionSettings(
	current: ExtensionSettingValues,
	update: ExtensionSettingValues,
): ExtensionSettingValues {
	const next: ExtensionSettingValues = { ...current };
	for (const [name, settings] of Object.entries(update)) {
		next[name] = { ...(current[name] ?? {}), ...settings };
	}
	return next;
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
	const { presets, dropped } = keepValidStoredPresets(loaded.customLayoutPresets);
	if (dropped.length > 0) setConfigAside(`dropped customLayoutPresets ${dropped.join(", ")}`);
	cached = { ...loaded, customLayoutPresets: presets };
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

/** `partial` passed the `AppConfigUpdate` params schema at dispatch. */
export function updateConfig(partial: AppConfigUpdate): AppConfig {
	const runtimeUpdate: RuntimeAppConfigUpdate = { ...partial };
	for (const key of DROPPED_UPDATE_KEYS) delete runtimeUpdate[key];
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
		extensionSettings,
		disabledPackages,
		...rest
	} = runtimeUpdate;
	if (runtimeUpdate.locale !== undefined && !isLocalePreference(runtimeUpdate.locale)) {
		throw new CodedError(
			"INVALID_PARAMS",
			'locale must be "system" or a canonical BCP-47 language tag',
		);
	}
	const current = configToOverwrite();
	if (
		runtimeUpdate.analyticsEnabled === true &&
		!current.analyticsEnabled &&
		current.analyticsConsentConfirmed &&
		runtimeUpdate.analyticsConsentConfirmed === undefined
	) {
		throw new CodedError(
			"ANALYTICS_CONSENT_REQUIRED",
			"enabling additional analytics requires an explicit confirmation",
		);
	}
	const nextThemeMode = themeMode ?? (theme !== undefined ? "fixed" : current.themeMode);
	const nextSystemThemePair =
		systemThemePair === undefined
			? current.systemThemePair
			: { light: systemThemePair.light, dark: systemThemePair.dark };
	if (nextThemeMode === "system" && !nextSystemThemePair) {
		throw new CodedError("THEME_PAIR_REQUIRED", "system theme mode requires a complete pair");
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
		...(favoriteModels === undefined ? {} : { favoriteModels: withoutRepeats(favoriteModels) }),
		...(disabledExtensions === undefined
			? {}
			: { disabledExtensions: [...new Set(disabledExtensions)] }),
		...(extensionSettings === undefined
			? {}
			: {
					extensionSettings: mergeExtensionSettings(
						current.extensionSettings ?? {},
						extensionSettings,
					),
				}),
		...(disabledPackages === undefined ? {} : { disabledPackages: [...new Set(disabledPackages)] }),
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
