import ts from "typescript";
import type { CodeSymbol } from "../core/types";
import { addEdge, calleeName, type EdgeSink, type Resolver, resolveAt } from "./edges";

export interface RendererScan {
	calls: readonly ts.CallExpression[];
	rendererMaps: readonly ts.PropertyAssignment[];
}

export interface ToolStats {
	tools: number;
	toolRenderers: number;
	toolsLinked: number;
}

interface Registration {
	names: string[];
	renderer: ts.Expression;
	site: ts.Node;
	prefix: boolean;
}

const RENDERER_REGISTRAR = "registerToolRenderer";
const PREFIX_REGISTRAR = "registerToolRendererPrefix";

function forOfNames(checker: ts.TypeChecker, argument: ts.Expression) {
	if (!ts.isIdentifier(argument)) return [];
	const declaration = checker.getSymbolAtLocation(argument)?.valueDeclaration;
	if (!declaration || !ts.isVariableDeclaration(declaration)) return [];
	const statement = declaration.parent.parent;
	if (!ts.isForOfStatement(statement) || !ts.isArrayLiteralExpression(statement.expression)) {
		return [];
	}
	return statement.expression.elements.flatMap((element) =>
		ts.isStringLiteralLike(element) ? [element.text] : [],
	);
}

function namesOf(checker: ts.TypeChecker, argument: ts.Expression) {
	const type = checker.getTypeAtLocation(argument);
	if (type.isStringLiteral()) return [type.value];
	return forOfNames(checker, argument);
}

function registrationFromCall(checker: ts.TypeChecker, call: ts.CallExpression) {
	const name = calleeName(call.expression);
	if (!name || !ts.isIdentifier(name)) return undefined;
	const isPrefix = name.text === PREFIX_REGISTRAR;
	if (!isPrefix && name.text !== RENDERER_REGISTRAR) return undefined;
	const [toolName, renderer] = call.arguments;
	if (!toolName || !renderer) return undefined;
	const names = namesOf(checker, toolName);
	if (names.length === 0) return undefined;
	const registration: Registration = { names, renderer, site: call, prefix: isPrefix };
	return registration;
}

function registrationsFromMap(property: ts.PropertyAssignment) {
	if (!ts.isObjectLiteralExpression(property.initializer)) return [];
	const registrations: Registration[] = [];
	for (const entry of property.initializer.properties) {
		if (!ts.isPropertyAssignment(entry) || !ts.isObjectLiteralExpression(entry.initializer)) {
			continue;
		}
		const toolName =
			ts.isIdentifier(entry.name) || ts.isStringLiteralLike(entry.name)
				? entry.name.text
				: undefined;
		const renderer = entry.initializer.properties.find(
			(candidate): candidate is ts.PropertyAssignment =>
				ts.isPropertyAssignment(candidate) &&
				ts.isIdentifier(candidate.name) &&
				candidate.name.text === "renderer",
		);
		if (!toolName || !renderer) continue;
		registrations.push({
			names: [toolName],
			renderer: renderer.initializer,
			site: entry,
			prefix: false,
		});
	}
	return registrations;
}

function rendererOwners(resolver: Resolver, renderer: ts.Expression) {
	const nameNode = ts.isPropertyAccessExpression(renderer) ? renderer.name : renderer;
	if (!ts.isIdentifier(nameNode)) return [];
	const target = resolveAt(resolver, nameNode, "value");
	return target.kind === "repo" ? target.owners : [];
}

export function extractToolRenderers(input: Resolver & { sink: EdgeSink; scan: RendererScan }) {
	const { repo, table, sink, scan } = input;
	const registrations = [
		...scan.calls.flatMap((call) => {
			const registration = registrationFromCall(repo.checker, call);
			return registration ? [registration] : [];
		}),
		...scan.rendererMaps.flatMap(registrationsFromMap),
	];
	const toolsByName = new Map<string, CodeSymbol[]>();
	for (const tool of table.tools) {
		const known = toolsByName.get(tool.name) ?? [];
		known.push(tool.symbol);
		toolsByName.set(tool.name, known);
	}
	const rendered = new Set<string>();
	const linked = new Set<string>();
	for (const registration of registrations) {
		const owners = rendererOwners(input, registration.renderer);
		const source = registration.site.getSourceFile();
		const line = source.getLineAndCharacterOfPosition(registration.site.getStart(source)).line + 1;
		for (const name of registration.names) {
			rendered.add(name);
			const tools = registration.prefix
				? [...toolsByName].flatMap(([toolName, symbols]) =>
						toolName.startsWith(name) ? symbols : [],
					)
				: (toolsByName.get(name) ?? []);
			for (const tool of tools) {
				for (const to of owners) {
					linked.add(tool.name);
					addEdge(sink, { from: tool, to, kind: "tool-render", line, label: tool.name });
				}
			}
		}
	}
	const stats: ToolStats = {
		tools: toolsByName.size,
		toolRenderers: rendered.size,
		toolsLinked: linked.size,
	};
	return stats;
}
