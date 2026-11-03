import ts from "typescript";
import type { CodeSymbol, SymbolId } from "../core/types";

interface ToolDefinition {
	name: string;
	symbol: CodeSymbol;
}

export interface SymbolTable {
	byId: Map<SymbolId, CodeSymbol>;
	byNode: Map<ts.Node, CodeSymbol>;
	names: Set<string>;
	moduleByFile: Map<string, CodeSymbol>;
	tools: ToolDefinition[];
	handlers: Map<string, CodeSymbol[]>;
}

export function createSymbolTable() {
	const table: SymbolTable = {
		byId: new Map(),
		byNode: new Map(),
		names: new Set(),
		moduleByFile: new Map(),
		tools: [],
		handlers: new Map(),
	};
	return table;
}

const MODULE_SYMBOL_NAME = "(module)";

export function moduleSymbolFor(input: {
	table: SymbolTable;
	file: string;
	module: string;
	isTest: boolean;
	lines: number;
	bodyHash: string;
}) {
	const { table, file } = input;
	const existing = table.moduleByFile.get(file);
	if (existing) return existing;
	const symbol: CodeSymbol = {
		id: `${file}#${MODULE_SYMBOL_NAME}` as SymbolId,
		name: MODULE_SYMBOL_NAME,
		kind: "module",
		file,
		module: input.module,
		startLine: 1,
		endLine: input.lines,
		exported: false,
		barrelExported: false,
		isTest: input.isTest,
		bodyHash: input.bodyHash,
		signatureHash: "",
		signature: "",
	};
	table.byId.set(symbol.id, symbol);
	table.moduleByFile.set(file, symbol);
	return symbol;
}

export function nearestSymbol(table: SymbolTable, node: ts.Node) {
	let current: ts.Node | undefined = node;
	while (current && !ts.isSourceFile(current)) {
		const symbol = table.byNode.get(current);
		if (symbol) return symbol;
		current = current.parent;
	}
	return undefined;
}
