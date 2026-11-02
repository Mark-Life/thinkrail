import {
	arr,
	bool,
	lit,
	nullable,
	num,
	oneOf,
	opt,
	type Schema,
	type Static,
	str,
	tuple,
	union,
} from "@earendil-works/pi-schema";
import { ExtensionSettingValues } from "./extension";
import { ThinkingLevel, WireModel } from "./model";
import { partialWireObj, wireObj } from "./wire";

export const ThemeMode = oneOf(["fixed", "system"]);
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

export const FontRole = oneOf(["interface", "code"]);
export type FontRole = Static<typeof FontRole>;

/** A bundled face named by the role it ships for, or a family name the client resolves. */
export const FontFamilyRef = union([wireObj({ builtin: FontRole }), wireObj({ name: str() })]);
export type FontFamilyRef = Static<typeof FontFamilyRef>;

/** One role's font: `family: null` is the role's bundled default; fallbacks draw what it lacks. */
export const FontChoice = wireObj({
	family: nullable(FontFamilyRef),
	fallbacks: arr(FontFamilyRef),
});
export type FontChoice = Static<typeof FontChoice>;

export const LayoutToolId = oneOf(["projects", "specs", "files", "review", "plan"]);
export type LayoutToolId = Static<typeof LayoutToolId>;

export const LayoutBottomAlignment = oneOf(["center", "center-left", "center-right", "full"]);
export type LayoutBottomAlignment = Static<typeof LayoutBottomAlignment>;

export const LayoutPresetCenterGroup = wireObj({ kind: lit("group"), id: str() });
export type LayoutPresetCenterGroup = Static<typeof LayoutPresetCenterGroup>;

const LayoutDirection = oneOf(["horizontal", "vertical"]);

export interface LayoutPresetCenterSplit {
	kind: "split";
	id: string;
	direction: "horizontal" | "vertical";
	weights: [number, number];
	children: [LayoutPresetCenterNode, LayoutPresetCenterNode];
}
export type LayoutPresetCenterNode = LayoutPresetCenterGroup | LayoutPresetCenterSplit;

export const LayoutPresetCenterNode: Schema<LayoutPresetCenterNode> = {
	$id: "LayoutPresetCenterNode",
	anyOf: [
		LayoutPresetCenterGroup,
		{
			type: "object",
			required: ["kind", "id", "direction", "weights", "children"],
			properties: {
				kind: lit("split"),
				id: str(),
				direction: LayoutDirection,
				weights: tuple([num(), num()]),
				children: tuple([{ $ref: "#" }, { $ref: "#" }]),
			},
		},
	],
};

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

export const LayoutPreset = wireObj({
	id: str(),
	name: str(),
	center: LayoutPresetCenterNode,
	left: LayoutPresetSideRegion,
	right: LayoutPresetSideRegion,
	bottom: LayoutPresetBottomRegion,
});
export type LayoutPreset = Static<typeof LayoutPreset>;

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
	terminalReplayKb: num(),
	composerGrowthLimit: ComposerGrowthLimit,
	chatLineWidth: num(),
	fileLineWidth: num(),
	chatLineWidthBounded: bool(),
	fileLineWidthBounded: bool(),
	/** When false, no text field shows the dictation mic and the chord does nothing. */
	voiceInputEnabled: bool(),
	customLayoutPresets: arr(LayoutPreset),
	/** Models the user starred in the picker, in display order; identity is `{provider, id}`. */
	favoriteModels: arr(WireModel),
	/** When false, a `request_changes` verdict records findings and waits — no automated fix cycle. */
	reviewAutoFix: bool(),
	/** When false, the worker's in-session `request_review` tool is withheld; the Review button still works. */
	agentReviewEnabled: bool(),
	subagentsEnabled: bool(),
	/** How many subagents one chat may run at once; more spawns queue FIFO. */
	subagentMaxConcurrent: num(),
	jbcentralQuotaEnabled: bool(),
	jbcentralQuotaRefreshSeconds: num(),
	/** Which shell new workspace terminals start on Windows; ignored on other platforms. */
	terminalWindowsShell: TerminalWindowsShell,
	/** Idle days after which a quiet workspace settles onto its project's shelf; `null` = never. */
	settleIdleDays: nullable(num()),
	disabledExtensions: arr(str()),
	extensionSettings: ExtensionSettingValues,
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
	codeFontSize: num(),
	/** Ligatures in the editor, diffs and code in chat and documents; the terminal never draws them. */
	codeLigatures: bool(),
	/** Shifts every text weight but the brand face's together. */
	fontWeightOffset: num(),
};

export const AppConfig = wireObj({
	...APP_CONFIG_FIELDS,
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
});
export type AppConfig = Static<typeof AppConfig>;

/** The `settings.update` payload: `null` clears an optional override back to unset (⇒ the default). */
export const AppConfigUpdate = partialWireObj({
	...APP_CONFIG_FIELDS,
	defaultModel: nullable(WireModel),
	defaultEffort: nullable(ThinkingLevel),
	reviewModel: nullable(WireModel),
	reviewEffort: nullable(ThinkingLevel),
});
export type AppConfigUpdate = Static<typeof AppConfigUpdate>;

export const SETTINGS_METHODS = {
	"settings.update": { params: wireObj({ config: AppConfigUpdate }), result: AppConfig },
};
