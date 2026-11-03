import ts from "typescript";
import type { CodeSymbol } from "../core/types";
import { addEdge, calleeName, type EdgeSink, ownerOfNode, type Resolver } from "./edges";
import type { RepoProgram } from "./program";
import { unwrapExpression } from "./syntax";
import { extractToolRenderers, type RendererScan, type ToolStats } from "./toolRenderers";

interface TransportInfo {
	requestDeclarations: Set<ts.Node>;
	subscribeDeclarations: Set<ts.Node>;
	methods: Set<string>;
	packages: Set<string>;
}

interface WireStats extends ToolStats {
	wireMethods: number;
	wireMethodsWithHandler: number;
	wireMethodsWithCaller: number;
	wireDynamicRequests: number;
	wireUnhandledRequests: number;
	wireChannels: number;
	wireChannelsLinked: number;
}

interface Channels {
	declarations: Set<ts.Node>;
	names: Map<ts.Node, Map<string, string>>;
	values: Set<string>;
	declaringFiles: Set<string>;
}

interface Wrapper {
	index: number;
	kind: "request" | "subscribe";
	callers: number;
	sites: number;
}

const TRANSPORT_NAME = /Transport$/;
const CHANNELS_NAME = /CHANNELS$/;
const MAX_WRAPPER_ROUNDS = 4;

function stringLiterals(type: ts.Type) {
	if (type.isStringLiteral()) return [type.value];
	if (!type.isUnion()) return [];
	const values: string[] = [];
	for (const member of type.types) {
		if (!member.isStringLiteral()) return [];
		values.push(member.value);
	}
	return values;
}

function literalsOf(checker: ts.TypeChecker, type: ts.Type) {
	if (!type.isTypeParameter()) return stringLiterals(type);
	const constraint = checker.getBaseConstraintOfType(type);
	return constraint ? stringLiterals(constraint) : [];
}

function memberNamed(
	node: ts.ClassDeclaration | ts.InterfaceDeclaration,
	name: string,
): ts.SignatureDeclaration | undefined {
	for (const member of node.members) {
		if (!member.name || !ts.isIdentifier(member.name) || member.name.text !== name) continue;
		if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) return member;
	}
	return undefined;
}

export function discoverTransport(input: {
	repo: RepoProgram;
	packageOf: (path: string) => string;
}) {
	const { repo, packageOf } = input;
	const info: TransportInfo = {
		requestDeclarations: new Set(),
		subscribeDeclarations: new Set(),
		methods: new Set(),
		packages: new Set(),
	};
	for (const { path, source, isTest } of repo.sources) {
		if (isTest || !source.text.includes("Transport")) continue;
		for (const statement of source.statements) {
			if (!ts.isClassDeclaration(statement) && !ts.isInterfaceDeclaration(statement)) continue;
			if (!statement.name || !TRANSPORT_NAME.test(statement.name.text)) continue;
			const request = memberNamed(statement, "request");
			const subscribe = memberNamed(statement, "subscribe");
			const parameter = request?.parameters[0];
			if (!request || !subscribe || !parameter) continue;
			const type = repo.checker.getTypeAtLocation(parameter);
			for (const method of literalsOf(repo.checker, type)) info.methods.add(method);
			info.requestDeclarations.add(request);
			info.subscribeDeclarations.add(subscribe);
			info.packages.add(packageOf(path));
		}
	}
	return info;
}

function discoverChannels(repo: RepoProgram) {
	const channels: Channels = {
		declarations: new Set(),
		names: new Map(),
		values: new Set(),
		declaringFiles: new Set(),
	};
	for (const { path, source, isTest } of repo.sources) {
		if (isTest || !source.text.includes("CHANNELS")) continue;
		for (const statement of source.statements) {
			if (!ts.isVariableStatement(statement)) continue;
			for (const declaration of statement.declarationList.declarations) {
				if (!ts.isIdentifier(declaration.name) || !CHANNELS_NAME.test(declaration.name.text))
					continue;
				let value = declaration.initializer;
				while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value))) {
					value = value.expression;
				}
				if (!value || !ts.isObjectLiteralExpression(value)) continue;
				const names = new Map<string, string>();
				for (const property of value.properties) {
					if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
					if (!ts.isStringLiteralLike(property.initializer)) continue;
					names.set(property.name.text, property.initializer.text);
					channels.values.add(property.initializer.text);
				}
				if (names.size === 0) continue;
				channels.declarations.add(declaration);
				channels.names.set(declaration, names);
				channels.declaringFiles.add(path);
			}
		}
	}
	return channels;
}

function aliasTarget(checker: ts.TypeChecker, node: ts.Node) {
	const symbol = checker.getSymbolAtLocation(node);
	if (!symbol) return undefined;
	return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function enclosingCallableName(parameter: ts.ParameterDeclaration) {
	const fn = parameter.parent;
	if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) return fn.name;
	if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
		const holder = fn.parent;
		if (ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder)) return holder.name;
	}
	return undefined;
}

function parameterOf(checker: ts.TypeChecker, argument: ts.Expression) {
	if (!ts.isIdentifier(argument)) return undefined;
	const declaration = aliasTarget(checker, argument)?.valueDeclaration;
	return declaration && ts.isParameter(declaration) ? declaration : undefined;
}

function collectSources(repo: RepoProgram, channelNames: readonly string[]) {
	const calls: ts.CallExpression[] = [];
	const channelRefs: ts.PropertyAccessExpression[] = [];
	const rendererMaps: ts.PropertyAssignment[] = [];
	const visit = (node: ts.Node, wantsChannels: boolean, wantsMaps: boolean) => {
		if (ts.isCallExpression(node) && node.arguments.length > 0) calls.push(node);
		if (
			wantsChannels &&
			ts.isPropertyAccessExpression(node) &&
			ts.isIdentifier(node.expression) &&
			channelNames.includes(node.expression.text)
		) {
			channelRefs.push(node);
		}
		if (
			wantsMaps &&
			ts.isPropertyAssignment(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === "toolRenderers"
		) {
			rendererMaps.push(node);
		}
		ts.forEachChild(node, (child) => visit(child, wantsChannels, wantsMaps));
	};
	for (const { source, isTest } of repo.sources) {
		if (isTest) continue;
		const wantsChannels = channelNames.some((name) => source.text.includes(name));
		visit(source, wantsChannels, source.text.includes("toolRenderers"));
	}
	return { calls, channelRefs, rendererMaps };
}

interface WireContext extends Resolver {
	sink: EdgeSink;
	transport: TransportInfo;
	packageOf: (path: string) => string;
	channels: Channels;
	calls: readonly ts.CallExpression[];
	channelRefs: readonly ts.PropertyAccessExpression[];
}

function lineOf(node: ts.Node) {
	const source = node.getSourceFile();
	return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function linkRequests(ctx: WireContext) {
	const { repo, table, sink, transport, channels, calls } = ctx;
	const { checker } = repo;
	const stats = { dynamic: 0, unhandled: 0 };
	const callers = new Set<string>();
	const subscribers = new Map<string, Set<CodeSymbol>>();
	const wrappers = new Map<ts.Symbol, Wrapper>();

	const linkRequest = (call: ts.CallExpression, method: string) => {
		const handlers = table.handlers.get(method);
		const from = ownerOfNode(ctx, call);
		if (!handlers || handlers.length === 0) {
			stats.unhandled++;
			return;
		}
		if (!from) return;
		callers.add(method);
		for (const to of handlers) {
			addEdge(sink, { from, to, kind: "wire-request", line: lineOf(call), label: method });
		}
	};

	const linkSubscriber = (call: ts.CallExpression, channel: string) => {
		if (!channels.values.has(channel)) return;
		const from = ownerOfNode(ctx, call);
		if (!from) return;
		const known = subscribers.get(channel) ?? new Set<CodeSymbol>();
		known.add(from);
		subscribers.set(channel, known);
	};

	const trackWrapper = (parameter: ts.ParameterDeclaration, kind: Wrapper["kind"]) => {
		const nameNode = enclosingCallableName(parameter);
		const fnSymbol = nameNode ? aliasTarget(checker, nameNode) : undefined;
		if (!fnSymbol) return false;
		const wrapper = wrappers.get(fnSymbol) ?? {
			index: parameter.parent.parameters.indexOf(parameter),
			kind,
			callers: 0,
			sites: 0,
		};
		wrapper.sites++;
		wrappers.set(fnSymbol, wrapper);
		return true;
	};

	const processSite = (call: ts.CallExpression, argument: ts.Expression, kind: Wrapper["kind"]) => {
		const value = unwrapExpression(argument);
		const parameter = parameterOf(checker, value);
		if (parameter && trackWrapper(parameter, kind)) return;
		const literals = literalsOf(checker, checker.getTypeAtLocation(value));
		const unknown =
			literals.length === 0 || (kind === "request" && literals.length >= transport.methods.size);
		if (unknown) {
			if (kind === "request") stats.dynamic++;
			return;
		}
		for (const literal of literals) {
			if (kind === "request") linkRequest(call, literal);
			else linkSubscriber(call, literal);
		}
	};

	for (const call of calls) {
		const name = calleeName(call.expression);
		if (!name || !ts.isIdentifier(name)) continue;
		if (name.text !== "request" && name.text !== "subscribe") continue;
		const declaration = aliasTarget(checker, name)?.valueDeclaration;
		const argument = call.arguments[0];
		if (!declaration || !argument) continue;
		if (transport.requestDeclarations.has(declaration)) processSite(call, argument, "request");
		else if (transport.subscribeDeclarations.has(declaration)) {
			processSite(call, argument, "subscribe");
		}
	}

	const handled = new Set<ts.Symbol>();
	for (let round = 0; round < MAX_WRAPPER_ROUNDS; round++) {
		const pending = [...wrappers].filter(([symbol]) => !handled.has(symbol));
		if (pending.length === 0) break;
		for (const [symbol] of pending) handled.add(symbol);
		const names = new Set(pending.map(([symbol]) => symbol.name));
		const bySymbol = new Map(pending);
		for (const call of calls) {
			const name = calleeName(call.expression);
			if (!name || !ts.isIdentifier(name) || !names.has(name.text)) continue;
			const target = aliasTarget(checker, name);
			const wrapper = target ? bySymbol.get(target) : undefined;
			const argument = wrapper ? call.arguments[wrapper.index] : undefined;
			if (!wrapper || !argument) continue;
			wrapper.callers++;
			processSite(call, argument, wrapper.kind);
		}
	}
	for (const wrapper of wrappers.values()) {
		if (wrapper.kind === "request" && wrapper.callers === 0) stats.dynamic += wrapper.sites;
	}
	return { ...stats, callers, subscribers };
}

const COMPARISONS: ReadonlySet<ts.SyntaxKind> = new Set([
	ts.SyntaxKind.EqualsEqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsEqualsToken,
	ts.SyntaxKind.EqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsToken,
]);

function isPublishingReference(reference: ts.PropertyAccessExpression) {
	const { parent } = reference;
	if (ts.isCallExpression(parent) && parent.arguments[0] === reference) {
		const callee = calleeName(parent.expression);
		if (callee && ts.isIdentifier(callee) && callee.text === "subscribe") return false;
	}
	return !(ts.isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind));
}

function collectPublishers(ctx: WireContext) {
	const { repo, transport, channels, channelRefs, packageOf } = ctx;
	const publishers = new Map<string, Map<CodeSymbol, number>>();
	for (const reference of channelRefs) {
		const declaration = aliasTarget(repo.checker, reference.expression)?.valueDeclaration;
		const names = declaration ? channels.names.get(declaration) : undefined;
		const channel = names?.get(reference.name.text);
		if (!channel) continue;
		const file = repo.pathOf.get(reference.getSourceFile());
		if (file === undefined || channels.declaringFiles.has(file)) continue;
		if (transport.packages.has(packageOf(file)) || !isPublishingReference(reference)) continue;
		const from = ownerOfNode(ctx, reference);
		if (!from) continue;
		const known = publishers.get(channel) ?? new Map<CodeSymbol, number>();
		if (!known.has(from)) known.set(from, lineOf(reference));
		publishers.set(channel, known);
	}
	return publishers;
}

function linkChannels(ctx: WireContext, subscribers: ReadonlyMap<string, Set<CodeSymbol>>) {
	const publishers = collectPublishers(ctx);
	let linked = 0;
	for (const channel of ctx.channels.values) {
		const from = publishers.get(channel);
		const to = subscribers.get(channel);
		if (!from || !to) continue;
		linked++;
		for (const [publisher, line] of from) {
			for (const subscriber of to) {
				addEdge(ctx.sink, {
					from: publisher,
					to: subscriber,
					kind: "wire-push",
					line,
					label: channel,
				});
			}
		}
	}
	return linked;
}

export function extractWireEdges(
	input: Resolver & {
		sink: EdgeSink;
		transport: TransportInfo;
		packageOf: (path: string) => string;
	},
) {
	const { repo, table, transport } = input;
	const channels = discoverChannels(repo);
	const channelNames = [...channels.declarations].flatMap((declaration) =>
		ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
			? [declaration.name.text]
			: [],
	);
	const { calls, channelRefs, rendererMaps } = collectSources(repo, channelNames);
	const ctx: WireContext = { ...input, channels, calls, channelRefs };
	const requests = linkRequests(ctx);
	const wireChannelsLinked = linkChannels(ctx, requests.subscribers);
	const scan: RendererScan = { calls, rendererMaps };
	const result: WireStats = {
		wireMethods: transport.methods.size,
		wireMethodsWithHandler: [...transport.methods].filter((method) => table.handlers.has(method))
			.length,
		wireMethodsWithCaller: requests.callers.size,
		wireDynamicRequests: requests.dynamic,
		wireUnhandledRequests: requests.unhandled,
		wireChannels: channels.values.size,
		wireChannelsLinked,
		...extractToolRenderers({ ...input, scan }),
	};
	return result;
}
