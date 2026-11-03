import ts from "typescript";
import type { CodeSymbol, SymbolId, SymbolKind } from "../core/types";
import { collapse } from "./syntax";
import type { SymbolTable } from "./table";
import { hashText, type TextRange } from "./tokens";

export interface ExportInfo {
	exported: Set<ts.Node>;
	barrel: Set<ts.Node>;
}

interface PendingHash {
	symbol: CodeSymbol;
	range: TextRange;
	excludes: TextRange[];
}

export interface Context {
	source: ts.SourceFile;
	path: string;
	module: string;
	isTest: boolean;
	root: string;
	checker: ts.TypeChecker;
	table: SymbolTable;
	exports: ExportInfo;
	wireMethods: ReadonlySet<string>;
	pending: Map<CodeSymbol, PendingHash>;
	seen: Map<string, number>;
	consumed: Set<ts.Node>;
	topLevel: TextRange[];
}

interface SymbolSpec {
	node: ts.Node;
	name: string;
	qualified: string;
	kind: SymbolKind;
	signature: string;
	parent?: CodeSymbol | undefined;
	nameNode?: ts.Node | undefined;
	modifiers?: readonly ts.ModifierLike[] | undefined;
}

const MAX_SIGNATURE = 600;

export function textOf(ctx: Context, node: ts.Node) {
	return collapse(node.getText(ctx.source));
}

export function rangeOf(ctx: Context, node: ts.Node): TextRange {
	return { start: node.getStart(ctx.source), end: node.end };
}

export function memberPrefix(parent: CodeSymbol | undefined, fallback: string | undefined) {
	if (parent) return `${parent.id.slice(parent.file.length + 1)}.`;
	return fallback ? `${fallback}.` : "";
}

function lineOf(ctx: Context, position: number) {
	return ctx.source.getLineAndCharacterOfPosition(position).line + 1;
}

export function addSymbol(ctx: Context, spec: SymbolSpec) {
	const count = (ctx.seen.get(spec.qualified) ?? 0) + 1;
	ctx.seen.set(spec.qualified, count);
	const qualified = count === 1 ? spec.qualified : `${spec.qualified}~${count}`;
	const range = rangeOf(ctx, spec.node);
	const exported = ctx.exports.exported.has(spec.node) || (spec.parent?.exported ?? false);
	const barrelExported =
		ctx.exports.barrel.has(spec.node) || (spec.parent?.barrelExported ?? false);
	const signature = spec.signature.replaceAll(ctx.root, "");
	const symbol: CodeSymbol = {
		id: `${ctx.path}#${qualified}` as SymbolId,
		name: spec.name,
		kind: spec.kind,
		file: ctx.path,
		module: ctx.module,
		startLine: lineOf(ctx, range.start),
		endLine: lineOf(ctx, range.end),
		exported,
		barrelExported,
		isTest: ctx.isTest,
		bodyHash: "",
		signatureHash: hashText(signature),
		signature: signature.slice(0, MAX_SIGNATURE),
		...(spec.parent ? { parent: spec.parent.id } : {}),
	};
	ctx.table.byId.set(symbol.id, symbol);
	ctx.table.byNode.set(spec.node, symbol);
	ctx.table.names.add(spec.name);
	const excludes: TextRange[] = [];
	if (spec.nameNode) excludes.push(rangeOf(ctx, spec.nameNode));
	for (const modifier of spec.modifiers ?? []) {
		if (
			modifier.kind === ts.SyntaxKind.ExportKeyword ||
			modifier.kind === ts.SyntaxKind.DefaultKeyword
		) {
			excludes.push(rangeOf(ctx, modifier));
		}
	}
	ctx.pending.set(symbol, { symbol, range, excludes });
	const parentHash = spec.parent ? ctx.pending.get(spec.parent) : undefined;
	if (parentHash) parentHash.excludes.push(range);
	else ctx.topLevel.push(range);
	return symbol;
}

export function printType(ctx: Context, type: ts.Type) {
	return ctx.checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
}

function inferredReturn(ctx: Context, fn: ts.SignatureDeclaration) {
	const signature = ctx.checker.getSignatureFromDeclaration(fn);
	if (!signature) return "";
	return printType(ctx, ctx.checker.getReturnTypeOfSignature(signature));
}

export function functionSignature(ctx: Context, fn: ts.SignatureDeclaration, exported: boolean) {
	const typeParameters = fn.typeParameters
		? `<${fn.typeParameters.map((parameter) => textOf(ctx, parameter)).join(", ")}>`
		: "";
	const parameters = fn.parameters.map((parameter) => textOf(ctx, parameter)).join(", ");
	const returned = fn.type ? textOf(ctx, fn.type) : exported ? inferredReturn(ctx, fn) : "";
	return `${typeParameters}(${parameters})${returned ? `: ${returned}` : ""}`;
}

export function isExportedNode(ctx: Context, node: ts.Node, parent: CodeSymbol | undefined) {
	return ctx.exports.exported.has(node) || (parent?.exported ?? false);
}
