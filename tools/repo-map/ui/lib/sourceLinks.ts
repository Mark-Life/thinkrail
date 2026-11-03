import type { CodeSymbol, Edge, EdgeKind, SymbolId } from "../../core/types";

export interface LineLink {
	start: number;
	end: number;
	target: SymbolId;
	kind: EdgeKind;
	title: string;
}

export interface LineToken {
	content: string;
	color?: string;
}

interface LineSegment extends LineToken {
	link?: LineLink;
}

export function edgesByLine(edges: readonly Edge[]) {
	const lines = new Map<number, Edge[]>();
	for (const edge of edges) {
		const bucket = lines.get(edge.line);
		if (bucket) bucket.push(edge);
		else lines.set(edge.line, [edge]);
	}
	return lines;
}

function escapeRegex(text: string) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lastSegment(name: string) {
	return name.slice(name.lastIndexOf(".") + 1);
}

function findWord(input: { text: string; word: string; taken: readonly LineLink[] }) {
	const pattern = new RegExp(`(?<![\\w$])${escapeRegex(input.word)}(?![\\w$])`, "g");
	for (const match of input.text.matchAll(pattern)) {
		const start = match.index;
		const end = start + input.word.length;
		if (!input.taken.some((link) => start < link.end && end > link.start)) return { start, end };
	}
	return undefined;
}

function findLiteral(input: { text: string; literal: string; taken: readonly LineLink[] }) {
	for (const quote of ['"', "'", "`"]) {
		const needle = `${quote}${input.literal}${quote}`;
		const position = input.text.indexOf(needle);
		if (position === -1) continue;
		const start = position + 1;
		const end = start + input.literal.length;
		if (!input.taken.some((link) => start < link.end && end > link.start)) return { start, end };
	}
	return undefined;
}

function findCall(input: { text: string; word: string; taken: readonly LineLink[] }) {
	if (!input.text.includes(input.word)) return undefined;
	const name = escapeRegex(input.word);
	const pattern = new RegExp(`(?<![\\w$])${name}(?=\\s*\\()|(?<=<)${name}(?![\\w$])`, "g");
	for (const match of input.text.matchAll(pattern)) {
		const start = match.index;
		const end = start + input.word.length;
		if (!input.taken.some((link) => start < link.end && end > link.start)) return { start, end };
	}
	return undefined;
}

function repeatRange(input: {
	text: string;
	edge: Edge;
	name: string;
	taken: readonly LineLink[];
}) {
	const { text, edge, name, taken } = input;
	if (edge.label && edge.kind !== "implements") {
		return findLiteral({ text, literal: edge.label, taken });
	}
	if (edge.kind !== "call" && edge.kind !== "new" && edge.kind !== "render") return undefined;
	return findCall({ text, word: lastSegment(name), taken });
}

export function innermostSymbol<T extends Pick<CodeSymbol, "startLine" | "endLine">>(
	symbols: readonly T[],
	line: number,
) {
	let best: T | undefined;
	for (const symbol of symbols) {
		if (symbol.startLine > line || symbol.endLine < line) continue;
		if (!best || symbol.endLine - symbol.startLine < best.endLine - best.startLine) best = symbol;
	}
	return best;
}

export function linksForLine(input: {
	text: string;
	edges: readonly Edge[];
	enclosing?: readonly Edge[];
	symbols: ReadonlyMap<SymbolId, Pick<CodeSymbol, "name" | "file" | "startLine">>;
}) {
	const { text, edges, symbols } = input;
	const links: LineLink[] = [];
	const ordered = [...edges].sort(
		(left, right) => Number(right.label !== undefined) - Number(left.label !== undefined),
	);
	for (const edge of ordered) {
		const target = symbols.get(edge.to);
		if (!target) continue;
		const literal = edge.label
			? findLiteral({ text, literal: edge.label, taken: links })
			: undefined;
		const range = literal ?? findWord({ text, word: lastSegment(target.name), taken: links });
		if (!range) continue;
		links.push({
			...range,
			target: edge.to,
			kind: edge.kind,
			title: `${target.file}:${target.startLine}`,
		});
	}
	for (const edge of input.enclosing ?? []) {
		const target = symbols.get(edge.to);
		if (!target) continue;
		const range = repeatRange({ text, edge, name: target.name, taken: links });
		if (!range) continue;
		links.push({
			...range,
			target: edge.to,
			kind: edge.kind,
			title: `${target.file}:${target.startLine}`,
		});
	}
	return links.sort((left, right) => left.start - right.start);
}

export function splitTokens(input: { tokens: readonly LineToken[]; links: readonly LineLink[] }) {
	const segments: LineSegment[] = [];
	let offset = 0;
	for (const token of input.tokens) {
		const tokenEnd = offset + token.content.length;
		let cursor = offset;
		for (const link of input.links) {
			if (link.end <= cursor || link.start >= tokenEnd) continue;
			if (link.start > cursor) {
				segments.push({
					...token,
					content: token.content.slice(cursor - offset, link.start - offset),
				});
			}
			const sliceEnd = Math.min(link.end, tokenEnd);
			segments.push({
				...token,
				content: token.content.slice(Math.max(link.start, cursor) - offset, sliceEnd - offset),
				link,
			});
			cursor = sliceEnd;
		}
		if (cursor < tokenEnd)
			segments.push({ ...token, content: token.content.slice(cursor - offset) });
		offset = tokenEnd;
	}
	return segments;
}
