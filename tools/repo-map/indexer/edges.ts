import ts from "typescript";
import type { CodeSymbol, Edge, EdgeKind } from "../core/types";
import { isTestPath, type RepoProgram } from "./program";
import { isWorkspaceImport } from "./resolver";
import { moduleSymbolFor, nearestSymbol, type SymbolTable } from "./table";
import { hashText } from "./tokens";

interface CallStats {
	callSites: number;
	resolvedInRepo: number;
	resolvedExternal: number;
	unresolved: number;
	dynamicCalls: number;
}

type ResolvedTarget =
	| { kind: "repo"; owners: CodeSymbol[] }
	| { kind: "external" }
	| { kind: "unknown" };

export interface EdgeSink {
	edges: Map<string, Edge>;
}

interface AddEdgeInput {
	from: CodeSymbol;
	to: CodeSymbol;
	kind: EdgeKind;
	line: number;
	label?: string;
}

export function addEdge(sink: EdgeSink, input: AddEdgeInput) {
	if (input.from === input.to) return;
	const { from, to, kind, line, label } = input;
	const key = `${from.id}\0${to.id}\0${kind}\0${label ?? ""}`;
	const known = sink.edges.get(key);
	if (known) {
		known.count++;
		return;
	}
	sink.edges.set(key, {
		from: from.id,
		to: to.id,
		kind,
		line,
		count: 1,
		...(label ? { label } : {}),
	});
}

export interface Resolver {
	repo: RepoProgram;
	table: SymbolTable;
	moduleOf: (path: string) => string;
	memo: Map<ts.Symbol, { value?: ResolvedTarget; type?: ResolvedTarget }>;
}

export function ownerOfNode(resolver: Resolver, node: ts.Node) {
	const found = nearestSymbol(resolver.table, node);
	if (found) return found;
	const source = node.getSourceFile();
	const file = resolver.repo.pathOf.get(source);
	if (file === undefined) return undefined;
	return moduleSymbolFor({
		table: resolver.table,
		file,
		module: resolver.moduleOf(file),
		isTest: isTestPath(file),
		lines: source.getLineStarts().length,
		bodyHash: hashText(""),
	});
}

function isTypeDeclaration(declaration: ts.Declaration) {
	return ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration);
}

function isAmbientAugmentation(declaration: ts.Declaration) {
	let node: ts.Node | undefined = declaration.parent;
	while (node && !ts.isModuleDeclaration(node)) node = node.parent;
	if (!node) return false;
	return Boolean(node.flags & ts.NodeFlags.GlobalAugmentation) || ts.isStringLiteral(node.name);
}

function isBareImport(resolver: Resolver, symbol: ts.Symbol) {
	let node: ts.Node | undefined = symbol.declarations?.[0];
	while (node && !ts.isImportDeclaration(node)) node = node.parent;
	if (!node || !ts.isStringLiteral(node.moduleSpecifier)) return false;
	const specifier = node.moduleSpecifier.text;
	if (specifier.startsWith(".")) return false;
	return !isWorkspaceImport(resolver.repo.workspace, specifier);
}

function resolveSymbol(
	resolver: Resolver,
	found: ts.Symbol | undefined,
	context: "value" | "type",
): ResolvedTarget {
	if (!found) return { kind: "unknown" };
	const entry = resolver.memo.get(found) ?? {};
	const known = entry[context];
	if (known) return known;
	const resolved = resolveUncached(resolver, found, context);
	entry[context] = resolved;
	resolver.memo.set(found, entry);
	return resolved;
}

function resolveUncached(
	resolver: Resolver,
	found: ts.Symbol,
	context: "value" | "type",
): ResolvedTarget {
	let symbol = found;
	if (symbol.flags & ts.SymbolFlags.Alias) {
		const aliased = resolver.repo.checker.getAliasedSymbol(symbol);
		if (!aliased.declarations?.length) {
			return isBareImport(resolver, symbol) ? { kind: "external" } : { kind: "unknown" };
		}
		symbol = aliased;
	}
	const declarations = symbol.declarations ?? [];
	if (declarations.length === 0) return { kind: "unknown" };
	const relevant =
		context === "value"
			? declarations.filter((declaration) => !isTypeDeclaration(declaration))
			: declarations.filter(
					(declaration) =>
						isTypeDeclaration(declaration) ||
						ts.isClassLike(declaration) ||
						ts.isEnumDeclaration(declaration) ||
						ts.isTypeParameterDeclaration(declaration) ||
						ts.isModuleDeclaration(declaration),
				);
	const candidates = relevant.length > 0 ? relevant : declarations;
	const inRepo = candidates.filter((declaration) =>
		resolver.repo.pathOf.has(declaration.getSourceFile()),
	);
	if (inRepo.length === 0) return { kind: "external" };
	if (inRepo.length < candidates.length && inRepo.every(isAmbientAugmentation)) {
		return { kind: "external" };
	}
	const owners = new Set<CodeSymbol>();
	for (const declaration of inRepo) {
		const owner = ownerOfNode(resolver, declaration);
		if (owner) owners.add(owner);
	}
	return { kind: "repo", owners: [...owners] };
}

export function resolveAt(resolver: Resolver, node: ts.Node, context: "value" | "type") {
	return resolveSymbol(resolver, resolver.repo.checker.getSymbolAtLocation(node), context);
}

export function calleeName(expression: ts.Expression): ts.Node | undefined {
	if (ts.isIdentifier(expression)) return expression;
	if (ts.isPropertyAccessExpression(expression)) return expression.name;
	if (ts.isElementAccessExpression(expression)) {
		return ts.isStringLiteralLike(expression.argumentExpression)
			? expression.argumentExpression
			: undefined;
	}
	if (
		ts.isParenthesizedExpression(expression) ||
		ts.isNonNullExpression(expression) ||
		ts.isAsExpression(expression) ||
		ts.isSatisfiesExpression(expression)
	) {
		return calleeName(expression.expression);
	}
	return undefined;
}

interface WalkContext extends Resolver {
	sink: EdgeSink;
	stats: CallStats;
	source: ts.SourceFile;
	file: string;
	isTest: boolean;
	callables: Map<CodeSymbol, boolean>;
}

const VALUE_REF_KINDS = new Set(["function", "method", "component", "hook", "wire-handler"]);
const TYPE_TARGET_KINDS = new Set(["interface", "type", "class", "enum"]);

function lineOf(ctx: WalkContext, node: ts.Node) {
	return ctx.source.getLineAndCharacterOfPosition(node.getStart(ctx.source)).line + 1;
}

function emit(
	ctx: WalkContext,
	owner: CodeSymbol | undefined,
	to: CodeSymbol,
	kind: EdgeKind,
	node: ts.Node,
) {
	const from = owner ?? ownerOfNode(ctx, node);
	if (!from) return;
	addEdge(ctx.sink, { from, to, kind, line: lineOf(ctx, node) });
}

function recordCall(
	ctx: WalkContext,
	owner: CodeSymbol | undefined,
	node: ts.CallExpression | ts.NewExpression,
	kind: "call" | "new",
) {
	ctx.stats.callSites++;
	const name = calleeName(node.expression);
	let target: ResolvedTarget = name ? resolveAt(ctx, name, "value") : { kind: "unknown" };
	if (target.kind === "unknown") {
		const declaration = ctx.repo.checker.getResolvedSignature(node)?.declaration;
		if (declaration && !ts.isJSDocSignature(declaration)) {
			const owners = ctx.repo.pathOf.has(declaration.getSourceFile())
				? [ownerOfNode(ctx, declaration)].filter((entry) => entry !== undefined)
				: undefined;
			target = owners ? { kind: "repo", owners } : { kind: "external" };
		}
	}
	if (target.kind === "external") {
		ctx.stats.resolvedExternal++;
		return;
	}
	if (target.kind === "unknown") {
		ctx.stats.unresolved++;
		return;
	}
	const from = owner ?? ownerOfNode(ctx, node);
	const callable = target.owners.filter(
		(entry) => entry !== from && entry.kind !== "interface" && entry.kind !== "type",
	);
	if (callable.length === 0) {
		ctx.stats.dynamicCalls++;
		return;
	}
	ctx.stats.resolvedInRepo++;
	for (const to of callable) emit(ctx, from, to, kind, node);
}

function recordDynamicImport(
	ctx: WalkContext,
	owner: CodeSymbol | undefined,
	node: ts.CallExpression,
) {
	const specifier = node.arguments[0];
	if (!specifier) return;
	const moduleSymbol = ctx.repo.checker.getSymbolAtLocation(specifier);
	if (!moduleSymbol) return;
	const defaultExport = ctx.repo.checker.tryGetMemberInModuleExports("default", moduleSymbol);
	if (defaultExport) recordValueRef(ctx, owner, node, defaultExport);
}

function isCallableSymbol(ctx: WalkContext, node: ts.Node, symbol: CodeSymbol) {
	if (VALUE_REF_KINDS.has(symbol.kind)) return true;
	if (symbol.kind !== "const") return false;
	const known = ctx.callables.get(symbol);
	if (known !== undefined) return known;
	const callable = ctx.repo.checker.getTypeAtLocation(node).getCallSignatures().length > 0;
	ctx.callables.set(symbol, callable);
	return callable;
}

function recordValueRef(
	ctx: WalkContext,
	owner: CodeSymbol | undefined,
	node: ts.Node,
	found: ts.Symbol | undefined,
) {
	const target = resolveSymbol(ctx, found, "value");
	if (target.kind !== "repo") return;
	for (const to of target.owners) {
		if (isCallableSymbol(ctx, node, to)) emit(ctx, owner, to, "call", node);
	}
}

function isDeclarationName(node: ts.Identifier) {
	const { parent } = node;
	if ("name" in parent && parent.name === node) return true;
	if ("propertyName" in parent && parent.propertyName === node) return true;
	return false;
}

function typeNameNode(name: ts.EntityName | ts.Expression) {
	if (ts.isQualifiedName(name)) return name.right;
	if (ts.isPropertyAccessExpression(name)) return name.name;
	return name;
}

function recordTypeRef(ctx: WalkContext, owner: CodeSymbol | undefined, name: ts.Node) {
	const target = resolveAt(ctx, name, "type");
	if (target.kind !== "repo") return;
	for (const to of target.owners) {
		if (TYPE_TARGET_KINDS.has(to.kind)) emit(ctx, owner, to, "type-ref", name);
	}
}

function visitType(ctx: WalkContext, node: ts.Node, owner: CodeSymbol | undefined) {
	const current = ctx.table.byNode.get(node) ?? owner;
	if (ts.isTypeReferenceNode(node)) recordTypeRef(ctx, current, typeNameNode(node.typeName));
	else if (ts.isExpressionWithTypeArguments(node))
		recordTypeRef(ctx, current, typeNameNode(node.expression));
	else if (ts.isImportTypeNode(node) && node.qualifier)
		recordTypeRef(ctx, current, typeNameNode(node.qualifier));
	else if (ts.isTypeQueryNode(node)) return;
	ts.forEachChild(node, (child) => visitType(ctx, child, current));
}

function emitImplements(
	ctx: WalkContext,
	from: CodeSymbol | undefined,
	targetSymbol: ts.Symbol | undefined,
	node: ts.Node,
) {
	if (!from || !targetSymbol) return;
	const target = resolveSymbol(ctx, targetSymbol, "value");
	if (target.kind !== "repo") return;
	for (const to of target.owners) {
		if (to.kind === "method") emit(ctx, from, to, "implements", node);
	}
}

function visitClassHeritage(
	ctx: WalkContext,
	node: ts.ClassLikeDeclaration,
	owner: CodeSymbol | undefined,
) {
	for (const clause of node.heritageClauses ?? []) {
		const isImplements = clause.token === ts.SyntaxKind.ImplementsKeyword;
		for (const heritage of clause.types) {
			const target = resolveAt(ctx, typeNameNode(heritage.expression), "type");
			if (target.kind === "repo") {
				for (const to of target.owners) {
					if (TYPE_TARGET_KINDS.has(to.kind)) {
						emit(ctx, owner, to, isImplements ? "implements" : "type-ref", heritage);
					}
				}
			}
			if (!isImplements && !ts.isIdentifier(heritage.expression)) {
				visit(ctx, heritage.expression, owner);
			}
			if (heritage.typeArguments) {
				for (const argument of heritage.typeArguments) visitType(ctx, argument, owner);
			}
			const baseType = ctx.repo.checker.getTypeAtLocation(heritage);
			for (const member of node.members) {
				const from = ctx.table.byNode.get(member);
				const name = member.name;
				if (!from || !name || !ts.isIdentifier(name)) continue;
				emitImplements(ctx, from, baseType.getProperty(name.text), member);
			}
		}
	}
}

function visitObjectLiteral(
	ctx: WalkContext,
	node: ts.ObjectLiteralExpression,
	owner: CodeSymbol | undefined,
) {
	const relevant = node.properties.filter(
		(property) =>
			ts.isMethodDeclaration(property) ||
			ts.isShorthandPropertyAssignment(property) ||
			(ts.isPropertyAssignment(property) &&
				(ts.isArrowFunction(property.initializer) ||
					ts.isFunctionExpression(property.initializer) ||
					ts.isIdentifier(property.initializer))),
	);
	if (relevant.length === 0) return;
	const contextual = ctx.repo.checker.getContextualType(node);
	if (!contextual) return;
	const declared = ctx.repo.checker.getNonNullableType(contextual);
	for (const property of relevant) {
		const name = property.name;
		if (!name || !(ts.isIdentifier(name) || ts.isStringLiteralLike(name))) continue;
		const memberSymbol = declared.getProperty(name.text);
		if (!memberSymbol) continue;
		const value = ts.isShorthandPropertyAssignment(property)
			? ctx.repo.checker.getShorthandAssignmentValueSymbol(property)
			: ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)
				? ctx.repo.checker.getSymbolAtLocation(property.initializer)
				: undefined;
		if (value) {
			const source = resolveSymbol(ctx, value, "value");
			if (source.kind === "repo") {
				for (const from of source.owners) {
					if (VALUE_REF_KINDS.has(from.kind)) emitImplements(ctx, from, memberSymbol, property);
				}
			}
			continue;
		}
		emitImplements(
			ctx,
			ctx.table.byNode.get(property) ?? owner ?? ownerOfNode(ctx, property),
			memberSymbol,
			property,
		);
	}
}

function visit(ctx: WalkContext, node: ts.Node, owner: CodeSymbol | undefined) {
	const mapped = ctx.table.byNode.get(node);
	if (mapped && mapped.kind === "tool" && mapped !== owner) {
		const parent = owner ?? ownerOfNode(ctx, node.parent);
		if (parent && parent !== mapped) emit(ctx, parent, mapped, "call", node);
	}
	const current = mapped ?? owner;

	if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isJsxClosingElement(node))
		return;
	if (ts.isTypeNode(node)) {
		visitType(ctx, node, current);
		return;
	}
	if (ts.isClassLike(node)) {
		visitClassHeritage(ctx, node, current);
		for (const member of node.members) visit(ctx, member, current);
		return;
	}
	if (ts.isHeritageClause(node)) {
		visitType(ctx, node, current);
		return;
	}
	if (ts.isCallExpression(node)) {
		const callee = node.expression;
		if (callee.kind === ts.SyntaxKind.ImportKeyword) recordDynamicImport(ctx, current, node);
		const isSpecial =
			callee.kind === ts.SyntaxKind.ImportKeyword || callee.kind === ts.SyntaxKind.SuperKeyword;
		if (!isSpecial) recordCall(ctx, current, node, "call");
		const name = calleeName(callee);
		if (ts.isPropertyAccessExpression(callee)) visit(ctx, callee.expression, current);
		else if (callee !== name && !ts.isIdentifier(callee)) visit(ctx, callee, current);
		for (const typeArgument of node.typeArguments ?? []) visitType(ctx, typeArgument, current);
		for (const argument of node.arguments) visit(ctx, argument, current);
		return;
	}
	if (ts.isNewExpression(node)) {
		recordCall(ctx, current, node, "new");
		if (ts.isPropertyAccessExpression(node.expression))
			visit(ctx, node.expression.expression, current);
		for (const typeArgument of node.typeArguments ?? []) visitType(ctx, typeArgument, current);
		for (const argument of node.arguments ?? []) visit(ctx, argument, current);
		return;
	}
	if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
		const tag = node.tagName;
		const isComponent = ts.isIdentifier(tag)
			? /^[A-Z]/.test(tag.text)
			: ts.isPropertyAccessExpression(tag);
		if (isComponent) {
			const nameNode = ts.isPropertyAccessExpression(tag) ? tag.name : tag;
			const target = resolveAt(ctx, nameNode, "value");
			if (target.kind === "repo") {
				for (const to of target.owners) emit(ctx, current, to, "render", node);
			}
		}
		visit(ctx, node.attributes, current);
		return;
	}
	if (ts.isObjectLiteralExpression(node)) visitObjectLiteral(ctx, node, current);
	if (ts.isShorthandPropertyAssignment(node)) {
		if (ctx.table.names.has(node.name.text)) {
			recordValueRef(
				ctx,
				current,
				node.name,
				ctx.repo.checker.getShorthandAssignmentValueSymbol(node),
			);
		}
		return;
	}
	if (ts.isPropertyAccessExpression(node)) {
		visit(ctx, node.expression, current);
		if (ctx.table.names.has(node.name.text)) {
			recordValueRef(ctx, current, node.name, ctx.repo.checker.getSymbolAtLocation(node.name));
		}
		return;
	}
	if (ts.isIdentifier(node)) {
		if (ctx.table.names.has(node.text) && !isDeclarationName(node)) {
			recordValueRef(ctx, current, node, ctx.repo.checker.getSymbolAtLocation(node));
		}
		return;
	}
	ts.forEachChild(node, (child) => visit(ctx, child, current));
}

export function collectEdges(input: Resolver & { sink: EdgeSink }) {
	const stats: CallStats = {
		callSites: 0,
		resolvedInRepo: 0,
		resolvedExternal: 0,
		unresolved: 0,
		dynamicCalls: 0,
	};
	for (const entry of input.repo.sources) {
		const ctx: WalkContext = {
			...input,
			stats,
			source: entry.source,
			file: entry.path,
			isTest: entry.isTest,
			callables: new Map(),
		};
		visit(ctx, entry.source, undefined);
	}
	return stats;
}
