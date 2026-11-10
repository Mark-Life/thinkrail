import { parseToolResultContent } from "./toolResultContent";

export function resultText(result: unknown): string {
	return parseToolResultContent(result).text;
}

/** The keys of a tool's input type `Args` whose value, when present, is a `V`. */
type ArgKey<Args, V> = {
	[K in keyof Args]-?: Exclude<Args[K], undefined> extends V ? K : never;
}[keyof Args] &
	string;

/**
 * `args[key]` when the model sent a string there, else `""`. Name the tool's input type as `Args`
 * (`strArg<ToolInputs["read"]>(args, "path")`): the key must be one of its string fields, so a renamed
 * parameter fails `tsc`. Without `Args` no key is accepted.
 */
export function strArg<Args>(
	args: Record<string, unknown>,
	key: NoInfer<ArgKey<Args, string>>,
): string {
	const v = args[key];
	return typeof v === "string" ? v : "";
}

/** `args[key]` when the model sent a number there, else `null`; `key` is a number field of `Args`. */
export function numArg<Args>(
	args: Record<string, unknown>,
	key: NoInfer<ArgKey<Args, number>>,
): number | null {
	const v = args[key];
	return typeof v === "number" ? v : null;
}

/** `args[key]` when the model sent a boolean there, else `null`; `key` is a boolean field of `Args`. */
export function boolArg<Args>(
	args: Record<string, unknown>,
	key: NoInfer<ArgKey<Args, boolean>>,
): boolean | null {
	const v = args[key];
	return typeof v === "boolean" ? v : null;
}

/** The items of the array at `args[key]`, unchecked, or `[]`; `key` is an array field of `Args`. */
export function listArg<Args>(
	args: Record<string, unknown>,
	key: NoInfer<ArgKey<Args, readonly unknown[]>>,
): unknown[] {
	const v: unknown = args[key];
	return Array.isArray(v) ? v : [];
}

/** The strings of the array at `args[key]`, skipping other items; `key` is a string-array field of `Args`. */
export function strListArg<Args>(
	args: Record<string, unknown>,
	key: NoInfer<ArgKey<Args, readonly string[]>>,
): string[] {
	const v: unknown = args[key];
	return Array.isArray(v) ? v.filter((item: unknown) => typeof item === "string") : [];
}

export function languageFromPath(path: string): string {
	const ext = path.split(".").at(-1)?.toLowerCase() ?? "";
	const map: Record<string, string> = {
		ts: "typescript",
		tsx: "tsx",
		js: "javascript",
		jsx: "jsx",
		mjs: "javascript",
		cjs: "javascript",
		json: "json",
		py: "python",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		css: "css",
		html: "html",
		md: "markdown",
		yml: "yaml",
		yaml: "yaml",
	};
	return map[ext] ?? "";
}
