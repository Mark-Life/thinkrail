import type { ReviewAnchor, ReviewAnchorState, ReviewSelector } from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { hashBytes } from "../fs";

const UTF8_BYTES = new TextEncoder();

export function hashContent(content: string | Uint8Array): string {
	return hashBytes(typeof content === "string" ? UTF8_BYTES.encode(content) : content);
}

export const TEXT_QUOTE_CONTEXT_CHARS = 32;

type LineRange = Extract<ReviewSelector, { kind: "lineRange" }>;
type TextQuote = Extract<ReviewSelector, { kind: "textQuote" }>;
type Structural = Extract<ReviewSelector, { kind: "structural" }>;
type Region = Extract<ReviewSelector, { kind: "region" }>;

const STRUCTURAL_SCHEME = /^[a-z][a-z0-9-]*$/;

export function lineRangeOf(anchor: ReviewAnchor): LineRange | undefined {
	return anchor.selectors.find((s): s is LineRange => s.kind === "lineRange");
}

export function textQuoteOf(anchor: ReviewAnchor): TextQuote | undefined {
	return anchor.selectors.find((s): s is TextQuote => s.kind === "textQuote");
}

export function isPositioned(anchor: ReviewAnchor): boolean {
	return anchor.selectors.some(
		(s) => s.kind === "lineRange" || s.kind === "structural" || s.kind === "region",
	);
}

function shown(value: string | number): string {
	return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function fraction(selector: Region, name: "x" | "y" | "width" | "height"): number {
	const value = selector[name];
	if (!Number.isFinite(value) || value < 0 || value > 1)
		throw new CodedError(
			"INVALID_PARAMS",
			`A region selector's ${name} must be a fraction in [0, 1], got ${shown(value)}.`,
		);
	return value;
}

function page(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value < 1)
		throw new CodedError(
			"INVALID_PARAMS",
			`A region selector's page must be a positive integer, got ${shown(value)}.`,
		);
	return value;
}

function narrowRegion(selector: Region): Region {
	const paged = page(selector.page);
	return {
		kind: "region",
		x: fraction(selector, "x"),
		y: fraction(selector, "y"),
		width: fraction(selector, "width"),
		height: fraction(selector, "height"),
		...(paged === undefined ? {} : { page: paged }),
	};
}

function narrowLineRange({ startLine, endLine }: LineRange): LineRange {
	if (!Number.isInteger(startLine) || !Number.isInteger(endLine))
		throw new CodedError(
			"INVALID_PARAMS",
			`A lineRange selector's lines must be integers, got ${shown(startLine)}-${shown(endLine)}.`,
		);
	if (startLine < 1 || endLine < startLine)
		throw new CodedError(
			"INVALID_PARAMS",
			`A lineRange selector must run from line 1 onwards, got ${startLine}-${endLine}.`,
		);
	return { kind: "lineRange", startLine, endLine };
}

function narrowStructural({ scheme, ref }: Structural): Structural {
	if (!STRUCTURAL_SCHEME.test(scheme))
		throw new CodedError(
			"INVALID_PARAMS",
			`A structural selector's scheme must match ${STRUCTURAL_SCHEME.source}, got ${shown(scheme)}.`,
		);
	if (ref.length === 0)
		throw new CodedError("INVALID_PARAMS", `A ${scheme} selector needs a non-empty ref.`);
	return { kind: "structural", scheme, ref };
}

function narrowSelector(selector: ReviewSelector): ReviewSelector {
	switch (selector.kind) {
		case "lineRange":
			return narrowLineRange(selector);
		case "textQuote":
			return {
				kind: "textQuote",
				exact: selector.exact,
				prefix: selector.prefix,
				suffix: selector.suffix,
			};
		case "diffHunk":
			return { kind: "diffHunk", hunkHeader: selector.hunkHeader };
		case "structural":
			return narrowStructural(selector);
		case "region":
			return narrowRegion(selector);
	}
}

export function validateSelectors(selectors: readonly ReviewSelector[]): ReviewSelector[] {
	return selectors.map(narrowSelector);
}

export function buildTextQuote(content: string, startLine: number, endLine: number): TextQuote {
	const lines = content.split("\n");
	const start = Math.max(1, startLine);
	const end = Math.min(lines.length, Math.max(start, endLine));
	const before = lines.slice(0, start - 1).join("\n");
	const exact = lines.slice(start - 1, end).join("\n");
	const after = lines.slice(end).join("\n");
	const prefixRaw = before.length > 0 ? `${before}\n` : "";
	const suffixRaw = after.length > 0 ? `\n${after}` : "";
	return {
		kind: "textQuote",
		exact,
		prefix: prefixRaw.slice(-TEXT_QUOTE_CONTEXT_CHARS),
		suffix: suffixRaw.slice(0, TEXT_QUOTE_CONTEXT_CHARS),
	};
}

function indicesOf(haystack: string, needle: string): number[] {
	if (needle.length === 0) return [];
	const out: number[] = [];
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at < 0) return out;
		out.push(at);
		from = at + 1;
	}
}

function lineAt(content: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset; i++) if (content.charCodeAt(i) === 10) line++;
	return line;
}

export interface ReanchorResult {
	state: ReviewAnchorState;
	anchor: ReviewAnchor;
}

function driftWithoutQuote(anchor: ReviewAnchor, hash: string): ReanchorResult {
	return isPositioned(anchor)
		? { state: "outdated", anchor }
		: { state: "moved", anchor: { ...anchor, contentHash: hash } };
}

export function reanchor(
	anchor: ReviewAnchor,
	content: string | Uint8Array | null,
): ReanchorResult {
	if (content === null) return { state: "outdated", anchor };
	const hash = hashContent(content);
	if (anchor.contentHash === hash) return { state: "anchored", anchor };
	if (typeof content !== "string") return driftWithoutQuote(anchor, hash);

	const quote = textQuoteOf(anchor);
	if (!quote) return driftWithoutQuote(anchor, hash);

	let matches = indicesOf(content, quote.exact);
	if (matches.length > 1 && (quote.prefix || quote.suffix)) {
		const disambiguated = matches.filter((at) => {
			const prefixOk = quote.prefix ? content.slice(0, at).endsWith(quote.prefix) : true;
			const suffixOk = quote.suffix
				? content.slice(at + quote.exact.length).startsWith(quote.suffix)
				: true;
			return prefixOk && suffixOk;
		});
		if (disambiguated.length > 0) matches = disambiguated;
	}
	const at = matches.length === 1 ? matches[0] : undefined;
	if (at === undefined || quote.exact.length === 0) return { state: "outdated", anchor };

	const startLine = lineAt(content, at);
	const endLine = startLine + (quote.exact.split("\n").length - 1);
	return {
		state: "moved",
		anchor: {
			...anchor,
			contentHash: hash,
			selectors: anchor.selectors.map((s) =>
				s.kind === "lineRange" ? { kind: "lineRange", startLine, endLine } : s,
			),
		},
	};
}
