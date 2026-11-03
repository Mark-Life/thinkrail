import ts from "typescript";

interface FileToken {
	start: number;
	text: string;
}

export interface TextRange {
	start: number;
	end: number;
}

const TOKEN_SEPARATOR = "\u0001";

export function hashText(text: string) {
	return Bun.hash(text).toString(36);
}

function isFormatterParen(node: ts.ParenthesizedExpression) {
	const inner = node.expression;
	if (ts.isJsxElement(inner) || ts.isJsxSelfClosingElement(inner) || ts.isJsxFragment(inner))
		return true;
	return ts.isReturnStatement(node.parent);
}

function pushLeaf(node: ts.Node, source: ts.SourceFile, tokens: FileToken[]) {
	if (node.kind === ts.SyntaxKind.EndOfFileToken || node.kind === ts.SyntaxKind.SemicolonToken)
		return;
	const start = node.getStart(source);
	if (ts.isJsxText(node)) {
		const text = node.text.replace(/\s+/g, " ").trim();
		if (text) tokens.push({ start, text });
		return;
	}
	if (ts.isStringLiteral(node)) {
		tokens.push({ start, text: `"${node.text}"` });
		return;
	}
	tokens.push({ start, text: node.getText(source) });
}

function collect(node: ts.Node, source: ts.SourceFile, tokens: FileToken[]) {
	if (ts.isJsxText(node) || ts.isStringLiteral(node)) {
		pushLeaf(node, source, tokens);
		return;
	}
	const children = node.getChildren(source);
	if (children.length === 0) {
		pushLeaf(node, source, tokens);
		return;
	}
	const dropParens = ts.isParenthesizedExpression(node) && isFormatterParen(node);
	const lastIndex = children.length - 1;
	children.forEach((child, index) => {
		if (ts.isJSDoc(child)) return;
		if (dropParens && (index === 0 || index === lastIndex)) return;
		const trailingComma =
			node.kind === ts.SyntaxKind.SyntaxList &&
			index === lastIndex &&
			child.kind === ts.SyntaxKind.CommaToken;
		if (trailingComma) return;
		collect(child, source, tokens);
	});
}

export function fileTokens(source: ts.SourceFile) {
	const tokens: FileToken[] = [];
	collect(source, source, tokens);
	return tokens;
}

function lowerBound(tokens: readonly FileToken[], start: number) {
	let low = 0;
	let high = tokens.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		const token = tokens[mid];
		if (token && token.start < start) low = mid + 1;
		else high = mid;
	}
	return low;
}

export function hashTokens(input: {
	tokens: readonly FileToken[];
	range: TextRange;
	excludes: readonly TextRange[];
}) {
	const excludes = [...input.excludes].sort((a, b) => a.start - b.start);
	const parts: string[] = [];
	let cursor = 0;
	for (let index = lowerBound(input.tokens, input.range.start); ; index++) {
		const token = input.tokens[index];
		if (!token || token.start >= input.range.end) break;
		let exclude = excludes[cursor];
		while (exclude && exclude.end <= token.start) {
			cursor++;
			exclude = excludes[cursor];
		}
		if (exclude && token.start >= exclude.start) continue;
		parts.push(token.text);
	}
	return hashText(parts.join(TOKEN_SEPARATOR));
}
