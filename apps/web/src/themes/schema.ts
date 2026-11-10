import {
	compile,
	int,
	lit,
	nullable,
	obj,
	oneOf,
	opt,
	type Static,
	str,
} from "@earendil-works/pi-schema";

export const THEME_COLOR_KEYS = [
	"accent",
	"accentHover",
	"accentSolid",
	"onAccent",
	"bubbleAccent",
	"background",
	"header",
	"content",
	"sidebar",
	"input",
	"elevated",
	"hover",
	"border",
	"borderStrong",
	"text",
	"muted",
	"hint",
	"selection",
	"selectionForeground",
	"editorSelection",
	"editorSelectionForeground",
	"info",
	"success",
	"danger",
	"dangerHover",
	"onDanger",
	"warning",
] as const;

export const ANSI_COLOR_KEYS = [
	"black",
	"red",
	"green",
	"yellow",
	"blue",
	"magenta",
	"cyan",
	"white",
	"brightBlack",
	"brightRed",
	"brightGreen",
	"brightYellow",
	"brightBlue",
	"brightMagenta",
	"brightCyan",
	"brightWhite",
] as const;

export const SYNTAX_COLOR_KEYS = [
	"foreground",
	"comment",
	"commentDoc",
	"keyword",
	"string",
	"number",
	"regexp",
	"annotation",
	"tag",
	"attributeName",
	"attributeValue",
	"property",
	"function",
	"type",
	"variable",
	"constant",
	"operator",
	"punctuation",
	"inserted",
	"deleted",
	"changed",
] as const;

export const DERIVED_THEME_COLOR_KEYS = ["dangerHover", "onDanger"] as const;

export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];
export type AnsiColorKey = (typeof ANSI_COLOR_KEYS)[number];
export type SyntaxColorKey = (typeof SYNTAX_COLOR_KEYS)[number];
type DerivedThemeColorKey = (typeof DERIVED_THEME_COLOR_KEYS)[number];

const THEME_ID = "^[a-z0-9](?:[a-z0-9._-]{0,63})$";
const HEX_COLOR = "^#[0-9a-f]{6}(?:[0-9a-f]{2})?$";
const HexColor = str({ pattern: HEX_COLOR });
export type HexColor = Static<typeof HexColor>;
const NativeOrHexColor = nullable(HexColor);

const ThemeColorsFile = obj({
	accent: HexColor,
	accentHover: HexColor,
	accentSolid: HexColor,
	onAccent: HexColor,
	bubbleAccent: HexColor,
	background: HexColor,
	header: HexColor,
	content: HexColor,
	sidebar: HexColor,
	input: HexColor,
	elevated: HexColor,
	hover: HexColor,
	border: HexColor,
	borderStrong: HexColor,
	text: HexColor,
	muted: HexColor,
	hint: HexColor,
	selection: HexColor,
	selectionForeground: NativeOrHexColor,
	editorSelection: HexColor,
	editorSelectionForeground: NativeOrHexColor,
	info: HexColor,
	success: HexColor,
	danger: HexColor,
	dangerHover: opt(
		str({
			pattern: HEX_COLOR,
			description:
				"Destructive button hover fill. Optional: defaults to danger darkened 12% toward black.",
		}),
	),
	onDanger: opt(
		str({
			pattern: HEX_COLOR,
			description:
				"Label on the destructive fills. Optional: defaults to the palette's text or background colour, whichever reads better on danger and dangerHover.",
		}),
	),
	warning: HexColor,
} satisfies Record<ThemeColorKey, unknown>);

const AnsiColors = obj({
	black: HexColor,
	red: HexColor,
	green: HexColor,
	yellow: HexColor,
	blue: HexColor,
	magenta: HexColor,
	cyan: HexColor,
	white: HexColor,
	brightBlack: HexColor,
	brightRed: HexColor,
	brightGreen: HexColor,
	brightYellow: HexColor,
	brightBlue: HexColor,
	brightMagenta: HexColor,
	brightCyan: HexColor,
	brightWhite: HexColor,
} satisfies Record<AnsiColorKey, unknown>);

const SyntaxColors = obj({
	foreground: HexColor,
	comment: HexColor,
	commentDoc: HexColor,
	keyword: HexColor,
	string: HexColor,
	number: HexColor,
	regexp: HexColor,
	annotation: HexColor,
	tag: HexColor,
	attributeName: HexColor,
	attributeValue: HexColor,
	property: HexColor,
	function: HexColor,
	type: HexColor,
	variable: HexColor,
	constant: HexColor,
	operator: HexColor,
	punctuation: HexColor,
	inserted: HexColor,
	deleted: HexColor,
	changed: HexColor,
} satisfies Record<SyntaxColorKey, unknown>);

/** A theme file as authors write it; `theme.schema.json` is this schema serialized. */
export const ThemeManifestFile = obj(
	{
		$schema: opt(str()),
		schemaVersion: lit(2),
		id: str({ pattern: THEME_ID }),
		label: str({ pattern: "\\S" }),
		order: int(),
		appearance: oneOf(["light", "dark"]),
		contrast: oneOf(["normal", "high"]),
		colors: ThemeColorsFile,
		ansi: AnsiColors,
		syntax: SyntaxColors,
	},
	{
		title: "ThinkRail theme manifest",
		description:
			"A complete, declarative ThinkRail UI, terminal, and syntax palette. Selected-text foreground overrides may be null to retain native behavior.",
	},
);
type ThemeManifestFile = Static<typeof ThemeManifestFile>;
const themeManifestFile = compile(ThemeManifestFile);

export type ThemeAppearance = ThemeManifestFile["appearance"];
export type ThemeContrast = ThemeManifestFile["contrast"];
/** The palette with both derived colors filled in. */
export type ThemeColors = Readonly<
	Omit<ThemeManifestFile["colors"], DerivedThemeColorKey> & Record<DerivedThemeColorKey, HexColor>
>;
export type ThemeManifest = Readonly<
	Omit<ThemeManifestFile, "colors" | "ansi" | "syntax"> & {
		colors: ThemeColors;
		ansi: Readonly<ThemeManifestFile["ansi"]>;
		syntax: Readonly<ThemeManifestFile["syntax"]>;
	}
>;

export type ThemeManifestParseResult =
	| { readonly ok: true; readonly value: ThemeManifest }
	| { readonly ok: false; readonly issues: readonly string[] };

const DANGER_HOVER_SCALE = 0.88;

function scaleRgb(color: HexColor, factor: number): HexColor {
	const channel = (start: number) =>
		Math.round(Number.parseInt(color.slice(start, start + 2), 16) * factor)
			.toString(16)
			.padStart(2, "0");
	return `#${channel(1)}${channel(3)}${channel(5)}${color.slice(7)}`;
}

function luminance(color: HexColor): number {
	const [red = 0, green = 0, blue = 0] = [1, 3, 5].map((start) => {
		const value = Number.parseInt(color.slice(start, start + 2), 16) / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(a: HexColor, b: HexColor): number {
	const [first, second] = [luminance(a), luminance(b)];
	return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function mostReadable(
	labels: readonly [HexColor, ...HexColor[]],
	fills: readonly HexColor[],
): HexColor {
	const worst = (label: HexColor) => Math.min(...fills.map((fill) => contrast(label, fill)));
	return labels.reduce((best, label) => (worst(label) > worst(best) ? label : best));
}

const THEME_ID_SLUG = new RegExp(THEME_ID);

export function isThemeIdSlug(value: string): boolean {
	return THEME_ID_SLUG.test(value);
}

function withDerivedColors(colors: ThemeManifestFile["colors"]): ThemeColors {
	const dangerHover = colors.dangerHover ?? scaleRgb(colors.danger, DANGER_HOVER_SCALE);
	const onDanger =
		colors.onDanger ?? mostReadable([colors.text, colors.background], [colors.danger, dangerHover]);
	return Object.freeze({ ...colors, dangerHover, onDanger });
}

export function parseThemeManifest(value: unknown): ThemeManifestParseResult {
	if (!themeManifestFile.check(value)) {
		const issues = themeManifestFile
			.errors(value)
			.map(({ path, message }) => `theme${path.replaceAll("/", ".")}: ${message}`);
		return { ok: false, issues };
	}
	const { colors, ansi, syntax, ...fields } = value;
	return {
		ok: true,
		value: Object.freeze({
			...fields,
			colors: withDerivedColors(colors),
			ansi: Object.freeze({ ...ansi }),
			syntax: Object.freeze({ ...syntax }),
		}),
	};
}

export function assertThemeManifest(value: unknown): ThemeManifest {
	const parsed = parseThemeManifest(value);
	if (!parsed.ok) throw new Error(`Invalid theme manifest:\n- ${parsed.issues.join("\n- ")}`);
	return parsed.value;
}
