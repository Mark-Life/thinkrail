import type { CodeSymbol, SymbolKind } from "../../core/types";

const KIND_LABELS: Record<SymbolKind, string> = {
	function: "fn",
	method: "mth",
	component: "cmp",
	hook: "hook",
	class: "cls",
	interface: "ifc",
	type: "type",
	enum: "enum",
	"wire-handler": "wire",
	tool: "tool",
	const: "const",
	module: "mod",
};

const KIND_NAMES: Record<SymbolKind, string> = {
	function: "Function",
	method: "Method",
	component: "Component",
	hook: "Hook",
	class: "Class",
	interface: "Interface",
	type: "Type",
	enum: "Enum",
	"wire-handler": "Wire handler",
	tool: "Agent tool",
	const: "Constant",
	module: "Module top level",
};

export function kindLabel(kind: SymbolKind) {
	return KIND_LABELS[kind];
}

export function kindName(kind: SymbolKind) {
	return KIND_NAMES[kind];
}

export function formatCount(value: number) {
	return value.toLocaleString("en-US");
}

export function formatLines(value: number) {
	return value >= 10_000 ? `${(value / 1000).toFixed(0)}k` : formatCount(value);
}

export function formatBytes(value: number) {
	return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function formatPercent(part: number, total: number) {
	if (total === 0) return "0%";
	return `${((part / total) * 100).toFixed(1)}%`;
}

export function plural(count: number, word: string) {
	return `${formatCount(count)} ${word}${count === 1 ? "" : "s"}`;
}

export function shortSha(sha: string) {
	return sha.slice(0, 8);
}

export function baseName(path: string) {
	return path.slice(path.lastIndexOf("/") + 1);
}

export function shortModule(path: string) {
	if (path === ".") return "repo root";
	return path.replace(/^(apps|packages)\//, "").replace("/src/", "/");
}

export function displayName(symbol: Pick<CodeSymbol, "name" | "file" | "kind">) {
	return symbol.kind === "module" ? baseName(symbol.file) : symbol.name;
}

export function fileLine(input: { file: string; line: number }) {
	return `${input.file}:${input.line}`;
}
