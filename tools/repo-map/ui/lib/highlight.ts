import type { HighlighterCore } from "shiki/core";

const THEME = "repo-map";
const MAX_HIGHLIGHT_LINES = 12_000;

let highlighter: Promise<HighlighterCore> | undefined;

function loadHighlighter() {
	highlighter ??= (async () => {
		const [core, engine, typescript, tsx] = await Promise.all([
			import("shiki/core"),
			import("shiki/engine/javascript"),
			import("shiki/langs/typescript.mjs"),
			import("shiki/langs/tsx.mjs"),
		]);
		return core.createHighlighterCore({
			themes: [
				core.createCssVariablesTheme({
					name: THEME,
					variablePrefix: "--code-",
					fontStyle: true,
				}),
			],
			langs: [typescript.default, tsx.default],
			engine: engine.createJavaScriptRegexEngine({ forgiving: true }),
		});
	})();
	return highlighter;
}

function nextTask() {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});
}

function languageOf(file: string) {
	if (file.endsWith(".tsx")) return "tsx";
	return file.endsWith(".ts") ? "typescript" : undefined;
}

export async function highlightLines(input: { code: string; file: string }) {
	const lang = languageOf(input.file);
	if (!lang || input.code.split("\n").length > MAX_HIGHLIGHT_LINES) return undefined;
	const shiki = await loadHighlighter();
	await nextTask();
	return shiki.codeToTokens(input.code, { lang, theme: THEME }).tokens;
}
