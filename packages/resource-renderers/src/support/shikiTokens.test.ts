import { describe, expect, test } from "bun:test";
import type { languages } from "monaco-editor/esm/vs/editor/editor.api.js";
import type { LanguageRegistration, ThemeRegistration } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { createShikiTokens } from "./shikiTokens";

const CATALOG = [
	{ id: "typescript", load: () => import("shiki/langs/typescript.mjs") },
	{ id: "markdown", load: () => import("shiki/langs/markdown.mjs") },
	{ id: "shellscript", load: () => import("shiki/langs/bash.mjs") },
];

async function themeNamed(load: Promise<{ default: ThemeRegistration }>) {
	return { ...(await load).default, name: "editor" };
}

const light = themeNamed(import("shiki/themes/github-light.mjs"));
const dark = themeNamed(import("shiki/themes/github-dark.mjs"));

function engine() {
	return createOnigurumaEngine(import("shiki/wasm"));
}

function tokenize(provider: languages.TokensProvider, lines: readonly string[]) {
	let state = provider.getInitialState();
	return lines.map((line) => {
		const result = provider.tokenize(line, state);
		state = result.endState;
		return result.tokens.map((token) => ({
			text: line.slice(token.startIndex),
			scopes: token.scopes,
		}));
	});
}

function scopeOf(
	tokens: readonly { text: string; scopes: string }[] | undefined,
	prefix: string,
): string | undefined {
	return tokens?.find((token) => token.text.startsWith(prefix))?.scopes;
}

async function themedTokens(catalog = CATALOG) {
	const tokens = createShikiTokens({ languages: catalog, engine });
	await tokens.applyTheme(await light);
	return tokens;
}

describe("createShikiTokens", () => {
	test("concurrent first uses of a language load its grammar once", async () => {
		let loads = 0;
		const tokens = await themedTokens([
			{
				id: "typescript",
				load: () => {
					loads += 1;
					return import("shiki/langs/typescript.mjs");
				},
			},
		]);
		const results = await Promise.all([tokens.ready("typescript"), tokens.ready("typescript")]);
		expect(results).toEqual([true, true]);
		expect(loads).toBe(1);
	});

	test("an unknown language resolves false without loading anything", async () => {
		const tokens = await themedTokens();
		expect(await tokens.ready("klingon")).toBe(false);
		expect(await tokens.loadEmbeds("klingon")).toBe(false);
	});

	test("a failed grammar load resolves false and the next call retries", async () => {
		let attempts = 0;
		const tokens = await themedTokens([
			{
				id: "typescript",
				load: (): Promise<{ default: LanguageRegistration[] }> => {
					attempts += 1;
					return attempts === 1
						? Promise.reject(new Error("chunk failed"))
						: import("shiki/langs/typescript.mjs");
				},
			},
		]);
		expect(await tokens.ready("typescript")).toBe(false);
		expect(await tokens.ready("typescript")).toBe(true);
		expect(attempts).toBe(2);
	});

	test("an engine that fails leaves every language plain", async () => {
		const tokens = createShikiTokens({
			languages: CATALOG,
			engine: () => Promise.reject(new Error("no wasm")),
		});
		expect(await tokens.ready("typescript")).toBe(false);
	});

	test("every catalog id resolves its own grammar name", async () => {
		const tokens = await themedTokens();
		for (const { id } of CATALOG) expect(await tokens.ready(id), id).toBe(true);
		const [line] = tokenize(tokens.provider("shellscript"), ["echo hi"]);
		expect(line?.some((token) => token.scopes !== "")).toBe(true);
	});

	test("the provider maps TypeScript tokens to theme scopes across a theme swap", async () => {
		const tokens = await themedTokens();
		await tokens.ready("typescript");
		const [before] = tokenize(tokens.provider("typescript"), ["const x = 1"]);
		expect(scopeOf(before, "const")).toBeTruthy();

		await tokens.applyTheme(await dark);
		const [after] = tokenize(tokens.provider("typescript"), ["const x = 1"]);
		expect(scopeOf(after, "const")).toBeTruthy();
		expect(scopeOf(after, "1")).toBeTruthy();
	});

	test("markdown fences colour once the in-catalog lazy embeds load", async () => {
		const tokens = await themedTokens();
		await tokens.ready("markdown");
		const fence = ["```ts", "const x = 1", "```"];
		const plainFence = scopeOf(tokenize(tokens.provider("markdown"), fence)[1], "const");

		expect(await tokens.loadEmbeds("markdown")).toBe(true);
		const keyword = scopeOf(tokenize(tokens.provider("typescript"), ["const x = 1"])[0], "const");
		const colouredFence = scopeOf(tokenize(tokens.provider("markdown"), fence)[1], "const");
		expect(colouredFence).toBe(keyword);
		expect(colouredFence).not.toBe(plainFence);
	});

	test("an over-long line becomes one unscoped token", async () => {
		const tokens = await themedTokens();
		await tokens.ready("typescript");
		const [line] = tokenize(tokens.provider("typescript"), ["x".repeat(20_000)]);
		expect(line).toEqual([{ text: "x".repeat(20_000), scopes: "" }]);
	});
});
