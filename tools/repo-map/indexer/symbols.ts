import ts from "typescript";
import type { CodeSymbol, SymbolKind } from "../core/types";
import {
	addSymbol,
	type Context,
	type ExportInfo,
	functionSignature,
	isExportedNode,
	memberPrefix,
	printType,
	rangeOf,
	textOf,
} from "./symbolContext";
import {
	containsJsx,
	functionOf,
	functionOfProperty,
	hasDynamicImport,
	isFunctionValued,
	objectHost,
	propertyNameText,
	returnedExpression,
	returnsJsx,
} from "./syntax";
import { moduleSymbolFor, type SymbolTable } from "./table";
import { fileTokens, hashText, hashTokens } from "./tokens";

const HOOK_NAME = /^use[A-Z]/;
const COMPONENT_NAME = /^[A-Z]/;

function functionKind(ctx: Context, name: string, fn: ts.FunctionLikeDeclaration): SymbolKind {
	if (HOOK_NAME.test(name)) return "hook";
	if (ctx.source.languageVariant !== ts.LanguageVariant.JSX) return "function";
	if (returnsJsx(fn)) return "component";
	if (COMPONENT_NAME.test(name) && fn.body && containsJsx(fn.body)) return "component";
	return "function";
}

function addFunctionEntry(
	ctx: Context,
	input: {
		property: Exclude<ts.ObjectLiteralElementLike, ts.SpreadAssignment>;
		name: string;
		prefix: string;
		parent: CodeSymbol | undefined;
		kind: SymbolKind;
	},
) {
	const { property, name, prefix, parent, kind } = input;
	const fn = functionOfProperty(property);
	const exported = isExportedNode(ctx, property, parent);
	const symbol = addSymbol(ctx, {
		node: property,
		name,
		qualified: `${prefix}${name}`,
		kind,
		signature: fn ? functionSignature(ctx, fn, exported) : textOf(ctx, property),
		parent,
		nameNode: property.name,
	});
	ctx.consumed.add(property);
	if (ts.isPropertyAssignment(property)) scan(ctx, property.initializer, symbol);
	else if (fn?.body) scan(ctx, fn.body, symbol);
	return symbol;
}

function isHandlerMap(ctx: Context, object: ts.ObjectLiteralExpression) {
	if (ctx.wireMethods.size === 0) return false;
	let total = 0;
	let matched = 0;
	for (const property of object.properties) {
		if (ts.isSpreadAssignment(property)) continue;
		total++;
		const name = propertyNameText(property.name);
		if (name && ctx.wireMethods.has(name)) matched++;
	}
	return matched > 0 && matched * 2 >= total;
}

function addHandlerMap(
	ctx: Context,
	object: ts.ObjectLiteralExpression,
	prefix: string,
	parent: CodeSymbol | undefined,
) {
	ctx.consumed.add(object);
	for (const property of object.properties) {
		const name = ts.isSpreadAssignment(property) ? undefined : propertyNameText(property.name);
		if (ts.isSpreadAssignment(property) || !name || !ctx.wireMethods.has(name)) {
			scan(ctx, property, parent);
			continue;
		}
		const symbol = addFunctionEntry(ctx, {
			property,
			name,
			prefix,
			parent,
			kind: "wire-handler",
		});
		const known = ctx.table.handlers.get(name) ?? [];
		known.push(symbol);
		ctx.table.handlers.set(name, known);
	}
}

function toolNameOf(ctx: Context, object: ts.ObjectLiteralExpression) {
	const names = new Map<string, ts.ObjectLiteralElementLike>();
	for (const property of object.properties) {
		const name = propertyNameText(property.name);
		if (name) names.set(name, property);
	}
	const nameProperty = names.get("name");
	if (!nameProperty || !names.has("execute") || !names.has("parameters")) return undefined;
	if (!ts.isPropertyAssignment(nameProperty)) return undefined;
	const type = ctx.checker.getTypeAtLocation(nameProperty.initializer);
	return type.isStringLiteral() ? type.value : undefined;
}

function addTool(
	ctx: Context,
	object: ts.ObjectLiteralExpression,
	name: string,
	prefix: string,
	parent: CodeSymbol | undefined,
) {
	const parameters = object.properties.find(
		(property) => propertyNameText(property.name) === "parameters",
	);
	const symbol = addSymbol(ctx, {
		node: object,
		name,
		qualified: `${prefix}${name}`,
		kind: "tool",
		signature: `tool ${name}${parameters ? ` ${textOf(ctx, parameters)}` : ""}`,
		parent,
	});
	ctx.table.tools.push({ name, symbol });
	ctx.consumed.add(object);
	ts.forEachChild(object, (child) => scan(ctx, child, symbol));
}

function claimSpecialObject(
	ctx: Context,
	object: ts.ObjectLiteralExpression,
	prefix: string,
	parent: CodeSymbol | undefined,
) {
	if (ctx.isTest) return false;
	const toolName = toolNameOf(ctx, object);
	if (toolName) {
		addTool(ctx, object, toolName, prefix, parent);
		return true;
	}
	if (isHandlerMap(ctx, object)) {
		addHandlerMap(ctx, object, prefix, parent);
		return true;
	}
	return false;
}

function addObjectEntries(
	ctx: Context,
	object: ts.ObjectLiteralExpression,
	prefix: string,
	parent: CodeSymbol | undefined,
) {
	if (claimSpecialObject(ctx, object, prefix, parent)) return;
	for (const property of object.properties) {
		if (ts.isSpreadAssignment(property) || !isFunctionValued(property)) continue;
		const name = propertyNameText(property.name);
		if (!name) continue;
		addFunctionEntry(ctx, { property, name, prefix, parent, kind: "method" });
	}
}

function scan(ctx: Context, node: ts.Node, parent: CodeSymbol | undefined) {
	if (ctx.consumed.has(node) || ts.isTypeNode(node)) return;
	if (
		ts.isObjectLiteralExpression(node) &&
		claimSpecialObject(ctx, node, memberPrefix(parent, undefined), parent)
	) {
		return;
	}
	ts.forEachChild(node, (child) => scan(ctx, child, parent));
}

function implementationOf(ctx: Context, node: ts.SignatureDeclaration) {
	const name = node.name;
	if (!name) return undefined;
	const symbol = ctx.checker.getSymbolAtLocation(name);
	return symbol?.declarations?.find(
		(declaration): declaration is ts.FunctionLikeDeclaration =>
			ts.isFunctionLike(declaration) && "body" in declaration && declaration.body !== undefined,
	);
}

function deferOverload(ctx: Context, node: ts.SignatureDeclaration, overloads: ts.Node[]) {
	if ("body" in node && node.body) return false;
	const implementation = implementationOf(ctx, node);
	if (!implementation) return false;
	overloads.push(node);
	ctx.consumed.add(node);
	ctx.topLevel.push(rangeOf(ctx, node));
	return true;
}

function linkOverloads(ctx: Context, overloads: readonly ts.Node[]) {
	for (const node of overloads) {
		if (!ts.isFunctionLike(node)) continue;
		const implementation = implementationOf(ctx, node);
		const symbol = implementation ? ctx.table.byNode.get(implementation) : undefined;
		if (symbol) ctx.table.byNode.set(node, symbol);
	}
}

function addFunctionDeclaration(
	ctx: Context,
	node: ts.FunctionDeclaration,
	prefix: string,
	parent: CodeSymbol | undefined,
) {
	const name = node.name?.text ?? "default";
	const symbol = addSymbol(ctx, {
		node,
		name,
		qualified: `${prefix}${name}`,
		kind: functionKind(ctx, name, node),
		signature: functionSignature(ctx, node, isExportedNode(ctx, node, parent)),
		parent,
		nameNode: node.name,
		modifiers: node.modifiers,
	});
	const host = objectHost(returnedExpression(node));
	if (host) addObjectEntries(ctx, host, `${prefix}${name}.`, symbol);
	if (node.body) scan(ctx, node.body, symbol);
}

function addVariable(
	ctx: Context,
	declaration: ts.VariableDeclaration,
	prefix: string,
	parent: CodeSymbol | undefined,
) {
	if (!ts.isIdentifier(declaration.name)) {
		scan(ctx, declaration, parent);
		return;
	}
	const name = declaration.name.text;
	const qualified = `${prefix}${name}`;
	const fn = functionOf(declaration.initializer);
	const exported = isExportedNode(ctx, declaration, parent);
	const host = objectHost(declaration.initializer);
	if (fn) {
		const symbol = addSymbol(ctx, {
			node: declaration,
			name,
			qualified,
			kind: functionKind(ctx, name, fn),
			signature: functionSignature(ctx, fn, exported),
			parent,
			nameNode: declaration.name,
		});
		if (host) addObjectEntries(ctx, host, `${qualified}.`, symbol);
		if (declaration.initializer) scan(ctx, declaration.initializer, symbol);
		return;
	}
	const isHook = HOOK_NAME.test(name);
	const isLazy = isLazyComponent(name, declaration.initializer);
	if (!exported && !isHook && !isLazy) {
		if (host) addObjectEntries(ctx, host, `${qualified}.`, parent);
		if (declaration.initializer) scan(ctx, declaration.initializer, parent);
		return;
	}
	const annotated = declaration.type
		? textOf(ctx, declaration.type)
		: printType(ctx, ctx.checker.getTypeAtLocation(declaration));
	const symbol = addSymbol(ctx, {
		node: declaration,
		name,
		qualified,
		kind: isHook ? "hook" : isLazy ? "component" : "const",
		signature: annotated,
		parent,
		nameNode: declaration.name,
	});
	if (host) addObjectEntries(ctx, host, `${qualified}.`, symbol);
	if (declaration.initializer) scan(ctx, declaration.initializer, symbol);
}

function isLazyComponent(name: string, initializer: ts.Expression | undefined) {
	return COMPONENT_NAME.test(name) && initializer !== undefined && hasDynamicImport(initializer);
}

function isCallableTypeNode(ctx: Context, node: ts.TypeNode | undefined) {
	if (!node) return false;
	if (ts.isFunctionTypeNode(node)) return true;
	if (!ts.isTypeReferenceNode(node) && !ts.isUnionTypeNode(node)) return false;
	const type = ctx.checker.getNonNullableType(ctx.checker.getTypeFromTypeNode(node));
	return type.getCallSignatures().length > 0;
}

function addTypeMembers(
	ctx: Context,
	members: readonly ts.TypeElement[],
	prefix: string,
	parent: CodeSymbol,
) {
	for (const member of members) {
		const name = propertyNameText(member.name);
		if (!name) continue;
		const isMethod = ts.isMethodSignature(member);
		if (!isMethod && !(ts.isPropertySignature(member) && isCallableTypeNode(ctx, member.type)))
			continue;
		addSymbol(ctx, {
			node: member,
			name,
			qualified: `${prefix}${name}`,
			kind: "method",
			signature: isMethod
				? functionSignature(ctx, member, false)
				: textOf(ctx, member).replace(/;$/, ""),
			parent,
			nameNode: member.name,
		});
	}
}

function classMemberFunction(member: ts.ClassElement): ts.SignatureDeclaration | undefined {
	if (
		ts.isMethodDeclaration(member) ||
		ts.isGetAccessorDeclaration(member) ||
		ts.isSetAccessorDeclaration(member) ||
		ts.isConstructorDeclaration(member)
	) {
		return member;
	}
	if (ts.isPropertyDeclaration(member)) return functionOf(member.initializer);
	return undefined;
}

function addClass(
	ctx: Context,
	node: ts.ClassDeclaration,
	prefix: string,
	parent: CodeSymbol | undefined,
) {
	const name = node.name?.text ?? "default";
	const qualified = `${prefix}${name}`;
	const heritage = (node.heritageClauses ?? []).map((clause) => textOf(ctx, clause)).join(" ");
	const classSymbol = addSymbol(ctx, {
		node,
		name,
		qualified,
		kind: "class",
		signature: `class ${name}${heritage ? ` ${heritage}` : ""}`,
		parent,
		nameNode: node.name,
		modifiers: node.modifiers,
	});
	const overloads: ts.Node[] = [];
	for (const member of node.members) {
		const memberName = ts.isConstructorDeclaration(member)
			? "constructor"
			: propertyNameText(member.name);
		const fn = classMemberFunction(member);
		const callableProperty =
			ts.isPropertyDeclaration(member) && !fn && isCallableTypeNode(ctx, member.type);
		if (!memberName || (!fn && !callableProperty)) {
			scan(ctx, member, classSymbol);
			continue;
		}
		if (fn && deferOverload(ctx, fn, overloads)) continue;
		const signature = fn ? functionSignature(ctx, fn, classSymbol.exported) : textOf(ctx, member);
		const memberSymbol = addSymbol(ctx, {
			node: member,
			name: memberName,
			qualified: `${qualified}.${memberName}`,
			kind: "method",
			signature,
			parent: classSymbol,
			nameNode: member.name,
		});
		scan(ctx, member, memberSymbol);
	}
	linkOverloads(ctx, overloads);
}

function addTypeLike(
	ctx: Context,
	node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration,
	prefix: string,
	parent: CodeSymbol | undefined,
) {
	const name = node.name.text;
	const qualified = `${prefix}${name}`;
	const kind: SymbolKind = ts.isInterfaceDeclaration(node)
		? "interface"
		: ts.isTypeAliasDeclaration(node)
			? "type"
			: "enum";
	const symbol = addSymbol(ctx, {
		node,
		name,
		qualified,
		kind,
		signature: textOf(ctx, node).replace(/^export\s+(default\s+)?/, ""),
		parent,
		nameNode: node.name,
		modifiers: node.modifiers,
	});
	if (ts.isInterfaceDeclaration(node)) addTypeMembers(ctx, node.members, `${qualified}.`, symbol);
	if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
		addTypeMembers(ctx, node.type.members, `${qualified}.`, symbol);
	}
}

function addExportAssignment(ctx: Context, node: ts.ExportAssignment) {
	const fn = functionOf(node.expression);
	if (!fn) {
		const host = objectHost(node.expression);
		if (host) claimSpecialObject(ctx, host, "default.", undefined);
		scan(ctx, node, undefined);
		return;
	}
	const symbol = addSymbol(ctx, {
		node,
		name: "default",
		qualified: "default",
		kind: functionKind(ctx, "default", fn),
		signature: functionSignature(ctx, fn, true),
		modifiers: node.modifiers,
	});
	scan(ctx, node.expression, symbol);
}

function addStatements(
	ctx: Context,
	statements: readonly ts.Statement[],
	prefix: string,
	parent: CodeSymbol | undefined,
) {
	const overloads: ts.Node[] = [];
	for (const statement of statements) {
		if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
			ctx.topLevel.push(rangeOf(ctx, statement));
		} else if (ts.isFunctionDeclaration(statement)) {
			if (!deferOverload(ctx, statement, overloads)) {
				addFunctionDeclaration(ctx, statement, prefix, parent);
			}
		} else if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				addVariable(ctx, declaration, prefix, parent);
			}
		} else if (ts.isClassDeclaration(statement)) {
			addClass(ctx, statement, prefix, parent);
		} else if (
			ts.isInterfaceDeclaration(statement) ||
			ts.isTypeAliasDeclaration(statement) ||
			ts.isEnumDeclaration(statement)
		) {
			addTypeLike(ctx, statement, prefix, parent);
		} else if (ts.isModuleDeclaration(statement)) {
			if (statement.body && ts.isModuleBlock(statement.body)) {
				addStatements(ctx, statement.body.statements, `${prefix}${statement.name.text}.`, parent);
			}
		} else if (ts.isExportAssignment(statement)) {
			addExportAssignment(ctx, statement);
		} else {
			scan(ctx, statement, parent);
		}
	}
	linkOverloads(ctx, overloads);
}

export function extractFileSymbols(input: {
	source: ts.SourceFile;
	path: string;
	module: string;
	isTest: boolean;
	root: string;
	checker: ts.TypeChecker;
	table: SymbolTable;
	exports: ExportInfo;
	wireMethods: ReadonlySet<string>;
}) {
	const ctx: Context = {
		...input,
		wireMethods: input.isTest ? new Set() : input.wireMethods,
		pending: new Map(),
		seen: new Map(),
		consumed: new Set(),
		topLevel: [],
	};
	addStatements(ctx, input.source.statements, "", undefined);
	const tokens = fileTokens(input.source);
	for (const { symbol, range, excludes } of ctx.pending.values()) {
		symbol.bodyHash = hashTokens({ tokens, range, excludes });
	}
	const remainder = hashTokens({
		tokens,
		range: { start: 0, end: input.source.end },
		excludes: ctx.topLevel,
	});
	const remainderEmpty = remainder === hashText("");
	if (!remainderEmpty) {
		moduleSymbolFor({
			table: input.table,
			file: input.path,
			module: input.module,
			isTest: input.isTest,
			lines: input.source.getLineStarts().length,
			bodyHash: remainder,
		});
	}
	return {
		contentHash: hashText(input.source.text),
		tokenHash: hashTokens({
			tokens,
			range: { start: 0, end: input.source.end },
			excludes: [],
		}),
	};
}
