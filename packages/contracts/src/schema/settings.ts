import {
	arr,
	bool,
	int,
	lit,
	map,
	nullable,
	num,
	obj,
	oneOf,
	opt,
	type Schema,
	type Static,
	type StaticObject,
	str,
	tuple,
	union,
	unknown,
} from "@earendil-works/pi-schema";
import { ExtensionSettingValues } from "./extension";
import { ThinkingLevel, WireModel } from "./model";
import type { Same } from "./typeTie";
import { narrowed, partialWireObj, recursive, wireObj } from "./wire";

export const THEME_MODES = ["fixed", "system"] as const;
export const ThemeMode = oneOf(THEME_MODES);
export type ThemeMode = Static<typeof ThemeMode>;

export const SystemThemePair = wireObj({ light: str(), dark: str() });
export type SystemThemePair = Static<typeof SystemThemePair>;

const THEME_PREFERENCE_FIELDS = {
	theme: str(),
	themeMode: ThemeMode,
	systemThemePair: opt(SystemThemePair),
};

export const ThemePreference = wireObj(THEME_PREFERENCE_FIELDS);
export type ThemePreference = Static<typeof ThemePreference>;

export const FONT_ROLES = ["interface", "code"] as const;
export const FontRole = oneOf(FONT_ROLES);
export type FontRole = Static<typeof FontRole>;

export const FONT_FAMILY_NAME_MAX_LENGTH = 128;
export const FONT_FALLBACKS_MAX = 8;
/** `editorDelta`: the editor and diffs render this many px below the code size. */
export const CODE_FONT_SIZE = { min: 10, max: 24, default: 13, editorDelta: 2 } as const;
export const FONT_WEIGHT_OFFSET = { min: -70, max: 130, step: 10, default: 0 } as const;

const FONT_NAME_CHAR = String.raw`[^"\\;{}\u0000-\u001f\u007f]`;
const FONT_NAME_EDGE = String.raw`[^\s"\\;{}\u0000-\u001f\u007f]`;

/** A CSS family name: no surrounding space, quote, backslash, `;`, braces or control character. */
export const FontFamilyName = str({
	maxLength: FONT_FAMILY_NAME_MAX_LENGTH,
	pattern: `^${FONT_NAME_EDGE}(?:${FONT_NAME_CHAR}*${FONT_NAME_EDGE})?$`,
});

/** A bundled face named by the role it ships for, or a family name the client resolves. Exactly one key. */
export const FontFamilyRef = union([obj({ builtin: FontRole }), obj({ name: FontFamilyName })]);
export type FontFamilyRef = Static<typeof FontFamilyRef>;

/** One role's font: `family: null` is the role's bundled default; fallbacks draw what it lacks. */
export const FontChoice = wireObj({
	family: nullable(FontFamilyRef),
	fallbacks: arr(FontFamilyRef, { maxItems: FONT_FALLBACKS_MAX, uniqueItems: true }),
});
export type FontChoice = Static<typeof FontChoice>;

export const CodeFontSize = int({ minimum: CODE_FONT_SIZE.min, maximum: CODE_FONT_SIZE.max });

export const FontWeightOffset = int({
	minimum: FONT_WEIGHT_OFFSET.min,
	maximum: FONT_WEIGHT_OFFSET.max,
	multipleOf: FONT_WEIGHT_OFFSET.step,
});

export const LINE_WIDTH_COLUMNS = { min: 40, max: 240, default: 120 } as const;
export const LineWidth = int({ minimum: LINE_WIDTH_COLUMNS.min, maximum: LINE_WIDTH_COLUMNS.max });

export const TERMINAL_REPLAY_KB = { min: 0, max: 1024, default: 64 } as const;
export const TerminalReplayKb = int({
	minimum: TERMINAL_REPLAY_KB.min,
	maximum: TERMINAL_REPLAY_KB.max,
});

export const SUBAGENT_MAX_CONCURRENT = { min: 1, max: 16, default: 4 } as const;
export const SubagentMaxConcurrent = int({
	minimum: SUBAGENT_MAX_CONCURRENT.min,
	maximum: SUBAGENT_MAX_CONCURRENT.max,
});

export const JBCENTRAL_QUOTA_REFRESH_SECONDS = { min: 1, max: 3600, default: 30 } as const;
export const JbcentralQuotaRefreshSeconds = int({
	minimum: JBCENTRAL_QUOTA_REFRESH_SECONDS.min,
	maximum: JBCENTRAL_QUOTA_REFRESH_SECONDS.max,
});

export const SETTLE_IDLE_DAYS = { min: 1, max: 365, default: 7 } as const;
/** Idle days after which a quiet workspace settles onto its project's shelf; `null` = never. */
export const SettleIdleDays = nullable(
	int({ minimum: SETTLE_IDLE_DAYS.min, maximum: SETTLE_IDLE_DAYS.max }),
);

export const LayoutToolId = oneOf(["projects", "specs", "files", "review", "plan"]);
export type LayoutToolId = Static<typeof LayoutToolId>;

export const LayoutBottomAlignment = oneOf(["center", "center-left", "center-right", "full"]);
export type LayoutBottomAlignment = Static<typeof LayoutBottomAlignment>;

export const LayoutPresetCenterGroup = wireObj({ kind: lit("group"), id: str() });
export type LayoutPresetCenterGroup = Static<typeof LayoutPresetCenterGroup>;

export const LayoutDirection = oneOf(["horizontal", "vertical"]);

const LAYOUT_PRESET_SPLIT_FIELDS = {
	kind: lit("split"),
	id: str(),
	direction: LayoutDirection,
	weights: tuple([num(), num()]),
};

export interface LayoutPresetCenterSplit extends StaticObject<typeof LAYOUT_PRESET_SPLIT_FIELDS> {
	children: [LayoutPresetCenterNode, LayoutPresetCenterNode];
}
export type LayoutPresetCenterNode = LayoutPresetCenterGroup | LayoutPresetCenterSplit;

const CenterNode = recursive("LayoutPresetCenterNode", (child: Schema<LayoutPresetCenterNode>) =>
	union([
		LayoutPresetCenterGroup,
		wireObj({ ...LAYOUT_PRESET_SPLIT_FIELDS, children: tuple([child, child]) }),
	]),
);
export const LayoutPresetCenterNode: Schema<
	Same<Static<typeof CenterNode>, LayoutPresetCenterNode>
> = CenterNode;

export const LayoutPresetSideGroup = wireObj({
	id: str(),
	weight: num(),
	folded: bool(),
	tools: arr(LayoutToolId),
});
export type LayoutPresetSideGroup = Static<typeof LayoutPresetSideGroup>;

export const LayoutPresetSideRegion = wireObj({
	visible: bool(),
	width: num(),
	groups: arr(LayoutPresetSideGroup),
});
export type LayoutPresetSideRegion = Static<typeof LayoutPresetSideRegion>;

export const LayoutPresetBottomGroup = LayoutPresetSideGroup;
export type LayoutPresetBottomGroup = LayoutPresetSideGroup;

export const LayoutPresetBottomRegion = wireObj({
	visible: bool(),
	height: num(),
	alignment: LayoutBottomAlignment,
	groups: arr(LayoutPresetBottomGroup),
});
export type LayoutPresetBottomRegion = Static<typeof LayoutPresetBottomRegion>;

const LAYOUT_PRESET_FIELDS = {
	id: str(),
	name: str(),
	left: LayoutPresetSideRegion,
	right: LayoutPresetSideRegion,
	bottom: LayoutPresetBottomRegion,
};

export const LayoutPreset = wireObj({ ...LAYOUT_PRESET_FIELDS, center: LayoutPresetCenterNode });
export type LayoutPreset = Static<typeof LayoutPreset>;

const LayoutPresetParams = wireObj({ ...LAYOUT_PRESET_FIELDS, center: map(unknown()) });

export const ComposerGrowthLimit = oneOf(["compact", "roomy", "half-chat"]);
export type ComposerGrowthLimit = Static<typeof ComposerGrowthLimit>;

export const TerminalWindowsShell = oneOf(["auto", "pwsh", "powershell", "cmd"]);
export type TerminalWindowsShell = Static<typeof TerminalWindowsShell>;

const APP_CONFIG_FIELDS = {
	...THEME_PREFERENCE_FIELDS,
	analyticsEnabled: bool(),
	analyticsConsentConfirmed: bool(),
	/** When true, the client may raise out-of-app attention notifications (still gated by browser permission). */
	notificationsEnabled: bool(),
	terminalReplayKb: TerminalReplayKb,
	composerGrowthLimit: ComposerGrowthLimit,
	chatLineWidth: LineWidth,
	fileLineWidth: LineWidth,
	chatLineWidthBounded: bool(),
	fileLineWidthBounded: bool(),
	/** When false, no text field shows the dictation mic and the chord does nothing. */
	voiceInputEnabled: bool(),
	/** Models the user starred in the picker, in display order; identity is `{provider, id}`. */
	favoriteModels: arr(WireModel),
	/** When false, a `request_changes` verdict records findings and waits — no automated fix cycle. */
	reviewAutoFix: bool(),
	/** When false, the worker's in-session `request_review` tool is withheld; the Review button still works. */
	agentReviewEnabled: bool(),
	subagentsEnabled: bool(),
	/** How many subagents one chat may run at once; more spawns queue FIFO. */
	subagentMaxConcurrent: SubagentMaxConcurrent,
	jbcentralQuotaEnabled: bool(),
	jbcentralQuotaRefreshSeconds: JbcentralQuotaRefreshSeconds,
	/** Which shell new workspace terminals start on Windows; ignored on other platforms. */
	terminalWindowsShell: TerminalWindowsShell,
	settleIdleDays: SettleIdleDays,
	disabledExtensions: arr(str()),
	extensionSettings: ExtensionSettingValues,
	/** Load skills from other agents' user directories and Claude plugins in projects that do not decide for themselves. */
	otherAgentSkills: bool(),
	/** pi package identities (`PiPackageSummary.identity`) switched off host-wide; pi has no such setting. */
	disabledPackages: arr(str()),
	/** UI language: `"system"` (follow the browser) or a BCP-47 tag; an unavailable tag renders English. */
	locale: str(),
	/** The user finished or skipped the cold-start onboarding wizard. */
	onboardingDismissed: bool(),
	/** All UI, chat and documents; the brand face is not user-changeable. */
	interfaceFont: FontChoice,
	/** The editor, diffs, code blocks and the terminal. */
	codeFont: FontChoice,
	/** Terminal and code blocks, in px; the editor and diffs render 2 px smaller. */
	codeFontSize: CodeFontSize,
	/** Ligatures in the editor, diffs and code in chat and documents; the terminal never draws them. */
	codeLigatures: bool(),
	/** Shifts every text weight but the brand face's together. */
	fontWeightOffset: FontWeightOffset,
};

const APP_CONFIG_RESULT_FIELDS = {
	...APP_CONFIG_FIELDS,
	customLayoutPresets: arr(LayoutPreset),
	/** The model new chats start with; unset uses the first available model. */
	defaultModel: opt(WireModel),
	/** New-chat effort; unset defaults to medium. */
	defaultEffort: opt(ThinkingLevel),
	/** The model the plan reviewer runs on; unset uses the host's new-chat model default. */
	reviewModel: opt(WireModel),
	/** Reviewer thinking level; unset uses the host's new-chat effort default, never the worker's inherited effort. */
	reviewEffort: opt(ThinkingLevel),
	/** Models most recently chosen for a chat, newest first; host-maintained, never client-written. */
	recentModels: arr(WireModel),
};

export const AppConfig = wireObj(APP_CONFIG_RESULT_FIELDS);
export type AppConfig = Static<typeof AppConfig>;

/** Every `AppConfig` field optional: a stored config or any host's welcome keeps each field that passes alone. */
export const PartialAppConfig = partialWireObj(APP_CONFIG_RESULT_FIELDS);
export type PartialAppConfig = Static<typeof PartialAppConfig>;

const NonBlank = str({ pattern: String.raw`\S` });
const NonEmpty = str({ minLength: 1 });
const NamedModel = narrowed(WireModel, { properties: { provider: NonEmpty, id: NonEmpty } });

const APP_CONFIG_UPDATE_FIELDS = {
	...APP_CONFIG_FIELDS,
	favoriteModels: arr(NamedModel),
	disabledExtensions: arr(NonBlank),
	disabledPackages: arr(NonBlank),
	extensionSettings: narrowed(ExtensionSettingValues, {
		propertyNames: NonBlank,
		additionalProperties: { propertyNames: NonBlank },
	}),
	customLayoutPresets: arr(LayoutPresetParams),
	defaultModel: nullable(NamedModel),
	defaultEffort: nullable(ThinkingLevel),
	reviewModel: nullable(NamedModel),
	reviewEffort: nullable(ThinkingLevel),
};

/** Keys an older client may still send: they pass, and the host drops them. */
export const DROPPED_UPDATE_KEYS = ["chatMessageOrder", "layout", "recentModels"] as const;

/** The `settings.update` payload: `null` clears an optional override back to unset (⇒ the default). */
export const AppConfigUpdate = narrowed(partialWireObj(APP_CONFIG_UPDATE_FIELDS), {
	propertyNames: oneOf([...Object.keys(APP_CONFIG_UPDATE_FIELDS), ...DROPPED_UPDATE_KEYS]),
	dependentRequired: { analyticsConsentConfirmed: ["analyticsEnabled"] },
});
export type AppConfigUpdate = Static<typeof AppConfigUpdate>;

export const SETTINGS_METHODS = {
	"settings.update": { params: wireObj({ config: AppConfigUpdate }), result: AppConfig },
};

export const SETTINGS_CHANNELS = {
	"settings.changed": AppConfig,
};
