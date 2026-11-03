import ts from "typescript";

const REACT_WRAPPERS = new Set(["memo", "forwardRef"]);
const ITERATION_METHODS = new Set([
	"map",
	"flatMap",
	"filter",
	"reduce",
	"forEach",
	"then",
	"catch",
	"finally",
]);
const MAX_HOST_DEPTH = 4;

export function collapse(text: string) {
	return text
		.replace(/\s+/g, " ")
		.replace(/,\s*([)}\]>])/g, "$1")
		.trim();
}

export function propertyNameText(name: ts.PropertyName | undefined) {
	if (!name) return undefined;
	if (
		ts.isIdentifier(name) ||
		ts.isPrivateIdentifier(name) ||
		ts.isStringLiteralLike(name) ||
		ts.isNumericLiteral(name)
	) {
		return name.text;
	}
	return undefined;
}

export function unwrapExpression(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (
		ts.isParenthesizedExpression(current) ||
		ts.isAsExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isNonNullExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function calleeLastName(expression: ts.Expression) {
	if (ts.isIdentifier(expression)) return expression.text;
	if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
	return undefined;
}

export function functionOf(
	expression: ts.Expression | undefined,
): ts.FunctionLikeDeclaration | undefined {
	if (!expression) return undefined;
	const value = unwrapExpression(expression);
	if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value;
	if (ts.isCallExpression(value)) {
		const callee = calleeLastName(value.expression);
		if (callee && REACT_WRAPPERS.has(callee)) return functionOf(value.arguments[0]);
	}
	return undefined;
}

export function returnedExpression(fn: ts.FunctionLikeDeclaration) {
	const { body } = fn;
	if (!body) return undefined;
	if (!ts.isBlock(body)) return body;
	for (const statement of [...body.statements].reverse()) {
		if (ts.isReturnStatement(statement)) return statement.expression;
	}
	return undefined;
}

export function objectHost(
	expression: ts.Expression | undefined,
	depth = 0,
): ts.ObjectLiteralExpression | undefined {
	if (!expression || depth > MAX_HOST_DEPTH) return undefined;
	const value = unwrapExpression(expression);
	if (ts.isObjectLiteralExpression(value)) return value;
	if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
		return objectHost(returnedExpression(value), depth + 1);
	}
	if (ts.isCallExpression(value)) {
		const callee = calleeLastName(value.expression);
		if (callee && ITERATION_METHODS.has(callee)) return undefined;
		for (const argument of value.arguments) {
			const host = objectHost(argument, depth + 1);
			if (host) return host;
		}
		return objectHost(value.expression, depth + 1);
	}
	return undefined;
}

export function containsJsx(node: ts.Node): boolean {
	if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node))
		return true;
	return ts.forEachChild(node, containsJsx) ?? false;
}

function jsxValue(expression: ts.Expression | undefined): boolean {
	if (!expression) return false;
	const value = unwrapExpression(expression);
	if (ts.isJsxElement(value) || ts.isJsxSelfClosingElement(value) || ts.isJsxFragment(value))
		return true;
	if (ts.isConditionalExpression(value))
		return jsxValue(value.whenTrue) || jsxValue(value.whenFalse);
	if (ts.isBinaryExpression(value)) return jsxValue(value.right);
	return false;
}

function hasJsxReturn(node: ts.Node): boolean {
	if (ts.isFunctionLike(node)) return false;
	if (ts.isReturnStatement(node)) return jsxValue(node.expression);
	return ts.forEachChild(node, hasJsxReturn) ?? false;
}

export function returnsJsx(fn: ts.FunctionLikeDeclaration) {
	const { body } = fn;
	if (!body) return false;
	return ts.isBlock(body) ? hasJsxReturn(body) : jsxValue(body);
}

export function hasDynamicImport(node: ts.Node): boolean {
	if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
		return true;
	return ts.forEachChild(node, hasDynamicImport) ?? false;
}

export function isFunctionValued(property: ts.ObjectLiteralElementLike) {
	if (ts.isMethodDeclaration(property)) return true;
	if (!ts.isPropertyAssignment(property)) return false;
	return functionOf(property.initializer) !== undefined;
}

export function functionOfProperty(property: ts.ObjectLiteralElementLike) {
	if (ts.isMethodDeclaration(property)) return property;
	if (ts.isPropertyAssignment(property)) return functionOf(property.initializer);
	return undefined;
}
