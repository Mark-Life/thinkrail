import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, JsonObject } from "@thinkrail/contracts";
import colorTokens from "../styles/colors.json";
import {
	ANSI_COLOR_KEYS,
	DERIVED_THEME_COLOR_KEYS,
	parseThemeManifest,
	SYNTAX_COLOR_KEYS,
	THEME_COLOR_KEYS,
	type ThemeManifest,
	ThemeManifestFile,
} from "./schema";

function bundledCandidates(): { file: string; value: unknown }[] {
	const dir = join(import.meta.dir, "bundled");
	return readdirSync(dir)
		.filter((file) => file.endsWith(".theme.json"))
		.sort()
		.map((file) => ({ file, value: JSON.parse(readFileSync(join(dir, file), "utf8")) }));
}

function bundledThemes(): ThemeManifest[] {
	return bundledCandidates().map(({ file, value }) => {
		const parsed = parseThemeManifest(value);
		if (!parsed.ok) throw new Error(`${file}: ${parsed.issues.join("; ")}`);
		return parsed.value;
	});
}

function luminance(hex: string): number {
	const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
	const [red = 0, green = 0, blue = 0] = channels.map((value) =>
		value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
	);
	return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(a: string, b: string): number {
	const [lighter = 0, darker = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (lighter + 0.05) / (darker + 0.05);
}

test("every bundled theme is complete, unique, and includes the configured default", () => {
	const themes = bundledThemes();
	const ids = themes.map((theme) => theme.id);
	expect(themes.length).toBeGreaterThan(0);
	expect(new Set(ids).size).toBe(ids.length);
	expect(ids).toContain(DEFAULT_CONFIG.theme);
});

test("theme.schema.json is the manifest schema serialized, so editors and the parser agree", () => {
	const file: unknown = JSON.parse(
		readFileSync(join(import.meta.dir, "theme.schema.json"), "utf8"),
	);
	expect(file).toEqual({
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: "https://thinkrail.dev/schemas/theme-manifest-v1.json",
		...JSON.parse(JSON.stringify(ThemeManifestFile)),
	});
});

test("the manifest schema lists the palette keys in their runtime order", () => {
	const property = (name: string): unknown =>
		JsonObject.check(ThemeManifestFile.properties) ? ThemeManifestFile.properties[name] : null;
	const [colors, ansi, syntax] = ["colors", "ansi", "syntax"].map(property);
	const keys = (schema: unknown) =>
		JsonObject.check(schema) && JsonObject.check(schema.properties)
			? Object.keys(schema.properties)
			: [];
	expect(keys(colors)).toEqual([...THEME_COLOR_KEYS]);
	expect(keys(ansi)).toEqual([...ANSI_COLOR_KEYS]);
	expect(keys(syntax)).toEqual([...SYNTAX_COLOR_KEYS]);
	const derived: readonly string[] = DERIVED_THEME_COLOR_KEYS;
	expect(JsonObject.check(colors) ? colors.required : null).toEqual(
		THEME_COLOR_KEYS.filter((key) => !derived.includes(key)),
	);
});

test("the parser rejects partial, unknown, and non-canonical manifest data all-or-nothing", () => {
	const source = bundledCandidates()[0]?.value;
	if (
		!JsonObject.check(source) ||
		!JsonObject.check(source.syntax) ||
		!JsonObject.check(source.colors)
	)
		throw new Error("the first bundled theme is not a manifest object");
	expect(parseThemeManifest(source).ok).toBe(true);

	const { keyword: _keyword, ...partialSyntax } = source.syntax;
	expect(parseThemeManifest({ ...source, syntax: partialSyntax }).ok).toBe(false);
	expect(parseThemeManifest({ ...source, injectedCss: "body { display: none }" }).ok).toBe(false);
	const colors = { ...source.colors, accent: "rgb(0, 0, 0)" };
	expect(parseThemeManifest({ ...source, colors }).ok).toBe(false);
});

test("a manifest written before the destructive keys existed still parses, with both derived", () => {
	for (const { file, value } of bundledCandidates()) {
		if (!JsonObject.check(value) || !JsonObject.check(value.colors))
			throw new Error(`${file}: not a manifest object`);
		const { dangerHover: sourceDangerHover, onDanger: _onDanger, ...colors } = value.colors;
		const parsed = parseThemeManifest({ ...value, colors });
		if (!parsed.ok) throw new Error(`${file}: ${parsed.issues.join("; ")}`);
		const { danger, dangerHover, onDanger, text, background } = parsed.value.colors;
		expect<unknown>(dangerHover, `${file}: derived dangerHover`).toBe(sourceDangerHover);
		expect([text, background]).toContain(onDanger);
		for (const fill of [danger, dangerHover])
			expect(
				contrast(onDanger, fill),
				`${file}: derived onDanger on ${fill}`,
			).toBeGreaterThanOrEqual(4.5);
	}
});

test("high-contrast manifests provide legible selected-text foregrounds", () => {
	const themes = bundledThemes().filter((theme) => theme.contrast === "high");
	expect(themes.length).toBeGreaterThan(0);
	for (const theme of themes) {
		const browserForeground = theme.colors.selectionForeground;
		const editorForeground = theme.colors.editorSelectionForeground;
		expect(browserForeground, `${theme.id}: browser selected-text foreground`).not.toBeNull();
		expect(editorForeground, `${theme.id}: editor selected-text foreground`).not.toBeNull();
		if (browserForeground) {
			expect(contrast(browserForeground, theme.colors.selection)).toBeGreaterThanOrEqual(4.5);
		}
		if (editorForeground) {
			expect(contrast(editorForeground, theme.colors.editorSelection)).toBeGreaterThanOrEqual(4.5);
		}
	}
});

const RESTING = ["background", "content", "sidebar", "header", "elevated", "input"] as const;
const FLOORS = [
	["text", 4.5],
	["muted", 4.5],
	["hint", 3],
	["accent", 4.5],
	["success", 4.5],
] as const;
const NOT_ON_INPUT: ReadonlySet<string> = new Set(["accent", "success"]);
const HOVER_FLOOR = 3;

const HIGH_CONTRAST_RESTING = 7;
const HIGH_CONTRAST_HOVER = 4.5;
const isHigh = (theme: { contrast: string }) => theme.contrast === "high";
const restingFloor = (theme: { contrast: string }, key: string, floor: number) =>
	isHigh(theme) && key !== "hint" ? Math.max(floor, HIGH_CONTRAST_RESTING) : floor;

test("every bundled manifest meets the contrast floors on every resting surface", () => {
	for (const theme of bundledThemes()) {
		for (const [key, floor] of FLOORS) {
			const foreground = theme.colors[key];
			for (const surface of RESTING) {
				if (NOT_ON_INPUT.has(key) && surface === "input") continue;
				expect(
					contrast(foreground, theme.colors[surface]),
					`${theme.id}: ${key} on ${surface}`,
				).toBeGreaterThanOrEqual(restingFloor(theme, key, floor));
			}
		}
	}
});

test("the primary control's label stays legible on both its resting and hover fill", () => {
	for (const theme of bundledThemes()) {
		for (const fill of ["accentSolid", "accentHover"] as const) {
			expect(
				contrast(theme.colors.onAccent, theme.colors[fill]),
				`${theme.id}: onAccent on ${fill}`,
			).toBeGreaterThanOrEqual(4.5);
		}
	}
});

test("the destructive control's label stays legible on both its resting and hover fill", () => {
	for (const theme of bundledThemes()) {
		for (const fill of ["danger", "dangerHover"] as const) {
			expect(
				contrast(theme.colors.onDanger, theme.colors[fill]),
				`${theme.id}: onDanger on ${fill}`,
			).toBeGreaterThanOrEqual(4.5);
		}
		expect(
			contrast(theme.colors.dangerHover, theme.colors.danger),
			`${theme.id}: dangerHover vs danger`,
		).toBeGreaterThanOrEqual(1.15);
	}
});

const ACTION_SURFACES = RESTING.filter((surface) => surface !== "content");

function tint(hex: string, over: string, percent: number): string {
	const channel = (value: string, start: number) =>
		Number.parseInt(value.slice(start, start + 2), 16);
	const mixed = [1, 3, 5].map((start) =>
		Math.round((channel(hex, start) * percent + channel(over, start) * (100 - percent)) / 100),
	);
	return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

test("the soft-primary label stays legible on its resting and hover tint over every resting surface", () => {
	const { scale } = colorTokens;
	for (const theme of bundledThemes()) {
		for (const surface of ACTION_SURFACES) {
			for (const step of ["subtle", "wash"] as const) {
				const fill = tint(theme.colors.accent, theme.colors[surface], scale[step]);
				expect(
					contrast(theme.colors.accent, fill),
					`${theme.id}: accent on accent@${step} over ${surface}`,
				).toBeGreaterThanOrEqual(4.5);
			}
		}
	}
});

const HOVER_DISTINCTION_FLOOR = 1.15;

test("the hover/selected fill stays distinguishable from every resting surface", () => {
	for (const theme of bundledThemes()) {
		for (const surface of RESTING) {
			expect(
				contrast(theme.colors.hover, theme.colors[surface]),
				`${theme.id}: hover vs ${surface}`,
			).toBeGreaterThanOrEqual(HOVER_DISTINCTION_FLOOR);
		}
	}
});

test("hovered text never drops below the visibility floor", () => {
	for (const theme of bundledThemes()) {
		for (const [key] of FLOORS) {
			const floor = isHigh(theme) && key !== "hint" ? HIGH_CONTRAST_HOVER : HOVER_FLOOR;
			expect(
				contrast(theme.colors[key], theme.colors.hover),
				`${theme.id}: ${key} on hover`,
			).toBeGreaterThanOrEqual(floor);
		}
	}
});
