import { textmateThemeToMonacoTheme } from "@shikijs/monaco";
import type { editor, languages } from "monaco-editor/esm/vs/editor/editor.api.js";
import {
	createHighlighterCore,
	type HighlighterCore,
	normalizeTheme,
	type RegexEngine,
	type ThemeRegistration,
} from "shiki/core";
import { EncodedTokenMetadata, INITIAL, type StateStack } from "shiki/textmate";
import type { ResourceCodeLanguage } from "../host";

const MAX_LINE_LENGTH = 20_000;
const TOKENIZE_TIME_LIMIT_MS = 500;
const FONT_STYLE_BITS = [
	[1, "italic"],
	[2, "bold"],
	[4, "underline"],
	[8, "strikethrough"],
] as const;

interface ShikiTokensOptions {
	languages: readonly Pick<ResourceCodeLanguage, "id" | "load">[];
	engine: () => Promise<RegexEngine>;
}

class LineState implements languages.IState {
	constructor(readonly ruleStack: StateStack) {}

	clone(): LineState {
		return this;
	}

	equals(other: languages.IState): boolean {
		return other instanceof LineState && other.ruleStack.equals(this.ruleStack);
	}
}

export function monacoThemeData(registration: ThemeRegistration) {
	return textmateThemeToMonacoTheme(normalizeTheme(registration)) as editor.IStandaloneThemeData;
}

function normalizeColor(color: string | undefined): string | undefined {
	if (!color) return undefined;
	const hex = (color.startsWith("#") ? color.slice(1) : color).toLowerCase();
	return hex.length === 3 || hex.length === 4
		? [...hex].map((digit) => digit + digit).join("")
		: hex;
}

function styleKey(color: string, fontStyle: string): string {
	return fontStyle ? `${color}|${fontStyle}` : color;
}

function fontStyleName(bits: number): string {
	return FONT_STYLE_BITS.filter(([bit]) => bits & bit)
		.map(([, name]) => name)
		.join(" ");
}

export function createShikiTokens({ languages: catalog, engine }: ShikiTokensOptions) {
	const byId = new Map(catalog.map((language) => [language.id, language]));
	const loads = new Map<string, Promise<readonly string[] | null>>();
	const scopeByStyle = new Map<string, string>();
	let colorMap: readonly (string | undefined)[] = [];
	let theme: ThemeRegistration | null = null;
	let generation = 0;
	let highlighter: HighlighterCore | null = null;
	let creating: Promise<HighlighterCore | null> | null = null;

	async function selectTheme(hl: HighlighterCore, registration: ThemeRegistration) {
		generation += 1;
		const name = `${registration.name ?? "theme"}#${generation}`;
		await hl.loadTheme({ ...registration, name });
		if (registration !== theme) return;
		colorMap = hl.setTheme(name).colorMap.map(normalizeColor);
		scopeByStyle.clear();
		for (const rule of monacoThemeData(registration).rules) {
			const color = normalizeColor(rule.foreground);
			if (!color) continue;
			const key = styleKey(color, rule.fontStyle ?? "");
			if (!scopeByStyle.has(key)) scopeByStyle.set(key, rule.token);
		}
	}

	function highlighterReady() {
		creating ??= engine()
			.then((regexEngine) => createHighlighterCore({ themes: [], langs: [], engine: regexEngine }))
			.then(async (hl) => {
				highlighter = hl;
				if (theme) await selectTheme(hl, theme);
				return hl;
			})
			.catch(() => null);
		return creating;
	}

	function loadGrammar(id: string) {
		let load = loads.get(id);
		if (load) return load;
		const language = byId.get(id);
		if (!language) return Promise.resolve(null);
		load = Promise.all([highlighterReady(), language.load()])
			.then(async ([hl, module]) => {
				if (!hl) return null;
				await hl.loadLanguage(module.default);
				const own = module.default.find((registration) => registration.name === id);
				return own?.embeddedLangsLazy?.filter((embed) => byId.has(embed)) ?? [];
			})
			.catch(() => {
				loads.delete(id);
				return null;
			});
		loads.set(id, load);
		return load;
	}

	async function ready(id: string) {
		return (await loadGrammar(id)) !== null;
	}

	async function loadEmbeds(id: string) {
		const embeds = await loadGrammar(id);
		if (!embeds?.length) return false;
		const loaded = await Promise.all(embeds.map(loadGrammar));
		return loaded.some((result) => result !== null);
	}

	function scopeOf(metadata: number) {
		const color = colorMap[EncodedTokenMetadata.getForeground(metadata)];
		if (!color) return "";
		const fontStyle = fontStyleName(EncodedTokenMetadata.getFontStyle(metadata));
		return scopeByStyle.get(styleKey(color, fontStyle)) ?? "";
	}

	function provider(id: string): languages.TokensProvider {
		return {
			getInitialState: () => new LineState(INITIAL),
			tokenize(line, state) {
				const current = state instanceof LineState ? state : new LineState(INITIAL);
				if (line.length >= MAX_LINE_LENGTH || !highlighter) {
					return { endState: current, tokens: [{ startIndex: 0, scopes: "" }] };
				}
				const result = highlighter
					.getLanguage(id)
					.tokenizeLine2(line, current.ruleStack, TOKENIZE_TIME_LIMIT_MS);
				const tokens: languages.IToken[] = [];
				for (let index = 0; index < result.tokens.length; index += 2) {
					tokens.push({
						startIndex: result.tokens[index] ?? 0,
						scopes: scopeOf(result.tokens[index + 1] ?? 0),
					});
				}
				return { endState: new LineState(result.ruleStack), tokens };
			},
		};
	}

	async function applyTheme(registration: ThemeRegistration) {
		theme = registration;
		if (highlighter) await selectTheme(highlighter, registration);
	}

	return { ready, loadEmbeds, provider, applyTheme };
}
