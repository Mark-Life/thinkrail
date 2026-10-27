import type { Text } from "@codemirror/state";
import type { SyntaxNode, SyntaxNodeRef, Tree } from "@lezer/common";

export interface Span {
	from: number;
	to: number;
}

export type InlineStyle = "strong" | "em" | "strike" | "code" | "link" | "marker";

export type LineStyle = "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "quote" | "codeblock";

export type LiveMark =
	| { kind: "hide"; from: number; to: number }
	| { kind: "style"; from: number; to: number; style: InlineStyle; href?: string }
	| { kind: "line"; at: number; style: LineStyle }
	| { kind: "bullet"; from: number; to: number }
	| { kind: "task"; from: number; to: number; checked: boolean; label: string }
	| { kind: "rule"; from: number; to: number };

const INLINE_STYLES: Readonly<Record<string, InlineStyle>> = {
	Emphasis: "em",
	StrongEmphasis: "strong",
	Strikethrough: "strike",
	InlineCode: "code",
};
const INLINE_MARKS = new Set(["EmphasisMark", "StrikethroughMark", "CodeMark"]);
const LINK_PARTS = new Set(["LinkMark", "URL", "LinkTitle", "LinkLabel"]);
const RAW_BLOCKS = new Set(["Table", "HTMLBlock"]);
const MUTED_BLOCKS = new Set(["CommentBlock", "ProcessingInstructionBlock", "LinkReference"]);
const LABEL_MARKUP = new Set([...INLINE_MARKS, "LinkMark", "URL", "LinkTitle", "HTMLTag"]);

export function touches(selection: readonly Span[] | null, from: number, to: number): boolean {
	return selection?.some((range) => range.from <= to && range.to >= from) ?? false;
}

function children(node: SyntaxNode): SyntaxNode[] {
	const out: SyntaxNode[] = [];
	for (let child = node.firstChild; child; child = child.nextSibling) out.push(child);
	return out;
}

const REFERENCE_CONTAINERS = new Set([
	"Document",
	"Blockquote",
	"BulletList",
	"OrderedList",
	"ListItem",
]);
const referenceCache = new WeakMap<Tree, ReadonlyMap<string, string>>();

function referenceKey(label: string): string {
	return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function unwrapUrl(url: string): string {
	return url.startsWith("<") && url.endsWith(">") ? url.slice(1, -1) : url;
}

function references(tree: Tree, doc: Text): ReadonlyMap<string, string> {
	const cached = referenceCache.get(tree);
	if (cached) return cached;
	const found = new Map<string, string>();
	tree.iterate({
		enter: (ref) => {
			if (ref.name === "LinkReference") {
				const label = ref.node.getChild("LinkLabel");
				const url = ref.node.getChild("URL");
				const key = label ? referenceKey(doc.sliceString(label.from + 1, label.to - 1)) : "";
				if (key && url && !found.has(key))
					found.set(key, unwrapUrl(doc.sliceString(url.from, url.to)));
				return false;
			}
			return REFERENCE_CONTAINERS.has(ref.name);
		},
	});
	referenceCache.set(tree, found);
	return found;
}

function plainText(tree: Tree, doc: Text, from: number, to: number): string {
	let text = "";
	let at = from;
	tree.iterate({
		from,
		to,
		enter: (ref) => {
			if (!LABEL_MARKUP.has(ref.name)) return true;
			text += doc.sliceString(at, Math.max(at, ref.from));
			at = Math.max(at, ref.to);
			return false;
		},
	});
	return (text + doc.sliceString(at, to)).replace(/\s+/g, " ").trim();
}

const EMAIL = /^[^\s@<>:/]+@[^\s@<>:/]+\.[^\s@<>:/]+$/;

function bareHref(text: string): string {
	if (/^www\./i.test(text)) return `https://${text}`;
	return EMAIL.test(text) ? `mailto:${text}` : text;
}

export function liveMarks({
	tree,
	doc,
	ranges,
	selection,
	skip = [],
	raw = [],
}: {
	tree: Tree;
	doc: Text;
	ranges: readonly Span[];
	selection: readonly Span[] | null;
	skip?: readonly Span[];
	raw?: readonly Span[];
}): LiveMark[] {
	const marks: LiveMark[] = [];
	const lineTouched = (pos: number) => {
		const line = doc.lineAt(pos);
		return touches(selection, line.from, line.to);
	};
	const style = (from: number, to: number, kind: InlineStyle, href?: string) => {
		if (to > from)
			marks.push(
				href === undefined
					? { kind: "style", from, to, style: kind }
					: { kind: "style", from, to, style: kind, href },
			);
	};
	const lines = (from: number, to: number, kind: LineStyle, range: Span, last = true) => {
		const first = doc.lineAt(Math.max(from, range.from)).number;
		const end = doc.lineAt(Math.min(to, range.to)).number;
		const stop = last || doc.lineAt(to).number !== end ? end : end - 1;
		for (let number = first; number <= stop; number += 1) {
			marks.push({ kind: "line", at: doc.line(number).from, style: kind });
		}
	};
	const hide = (from: number, to: number) => {
		for (let at = from; at < to; ) {
			const end = Math.min(to, doc.lineAt(at).to);
			if (end > at) marks.push({ kind: "hide", from: at, to: end });
			at = end + 1;
		}
	};
	const blankAfter = (pos: number, limit: number) =>
		pos + (/^[ \t]*/.exec(doc.sliceString(pos, limit))?.[0].length ?? 0);
	const blankBefore = (pos: number, limit: number) =>
		pos - (/[ \t]*$/.exec(doc.sliceString(limit, pos))?.[0].length ?? 0);

	const headerMark = (ref: SyntaxNodeRef, parent: SyntaxNode) => {
		if (parent.name.startsWith("Setext") || lineTouched(ref.from)) {
			style(ref.from, ref.to, "marker");
		} else if (ref.from === parent.from) {
			hide(ref.from, blankAfter(ref.to, parent.to));
		} else {
			hide(blankBefore(ref.from, parent.from), ref.to);
		}
	};

	const linkHref = (parts: readonly SyntaxNode[], brackets: readonly SyntaxNode[]) => {
		const url = parts.find((child) => child.name === "URL");
		if (url) return unwrapUrl(doc.sliceString(url.from, url.to));
		if (brackets.length > 2) return "";
		const label = parts.find((child) => child.name === "LinkLabel");
		const [open, close] = brackets;
		const key =
			label && label.to - label.from > 2
				? doc.sliceString(label.from + 1, label.to - 1)
				: open && close
					? doc.sliceString(open.to, close.from)
					: "";
		return references(tree, doc).get(referenceKey(key)) ?? null;
	};

	const link = (node: SyntaxNode) => {
		const parts = children(node).filter((child) => LINK_PARTS.has(child.name));
		const brackets = parts.filter((child) => child.name === "LinkMark");
		const href = linkHref(parts, brackets);
		if (href === null) return;
		const [open, close] = brackets;
		if (open && close) style(open.to, close.from, "link", href);
		const shown = touches(selection, node.from, node.to);
		for (const part of parts) {
			if (shown) style(part.from, part.to, "marker");
			else hide(part.from, part.to);
		}
	};

	const autolink = (node: SyntaxNode) => {
		const shown = touches(selection, node.from, node.to);
		for (const part of children(node)) {
			if (part.name === "URL") {
				style(part.from, part.to, "link", bareHref(doc.sliceString(part.from, part.to)));
			} else if (shown) style(part.from, part.to, "marker");
			else hide(part.from, part.to);
		}
	};

	const skipped = [...skip, ...raw];
	for (const range of ranges) {
		for (const span of raw) {
			if (span.from <= range.to && span.to >= range.from)
				lines(span.from, span.to, "codeblock", range);
		}
		tree.iterate({
			from: range.from,
			to: range.to,
			enter: (ref) => {
				if (
					ref.name !== "Document" &&
					skipped.some((block) => block.from <= ref.from && ref.from < block.to)
				) {
					return false;
				}
				const { name } = ref;
				const parent = ref.node.parent;
				const heading = /^(ATX|Setext)Heading([1-6])$/.exec(name);
				if (heading) {
					lines(ref.from, ref.to, `h${heading[2]}` as LineStyle, range, heading[1] === "ATX");
					return true;
				}
				if (name === "HeaderMark" && parent) {
					headerMark(ref, parent);
					return false;
				}
				if (name === "Blockquote") {
					lines(ref.from, ref.to, "quote", range);
					return true;
				}
				if (name === "QuoteMark") {
					if (lineTouched(ref.from)) style(ref.from, ref.to, "marker");
					else {
						const spaced = doc.sliceString(ref.to, ref.to + 1) === " " ? 1 : 0;
						hide(ref.from, ref.to + spaced);
					}
					return false;
				}
				if (name === "ListMark") {
					if (parent?.parent?.name !== "BulletList") return false;
					if (lineTouched(ref.from)) style(ref.from, ref.to, "marker");
					else if (parent.getChild("Task")) {
						hide(ref.from, blankAfter(ref.to, parent.to));
					} else marks.push({ kind: "bullet", from: ref.from, to: ref.to });
					return false;
				}
				if (name === "TaskMarker") {
					if (lineTouched(ref.from)) style(ref.from, ref.to, "marker");
					else {
						const checked = /x/i.test(doc.sliceString(ref.from, ref.to));
						const end = Math.min(parent?.to ?? ref.to, doc.lineAt(ref.from).to);
						const label = plainText(tree, doc, ref.to, end);
						marks.push({ kind: "task", from: ref.from, to: ref.to, checked, label });
					}
					return false;
				}
				if (name === "HorizontalRule") {
					if (lineTouched(ref.from)) style(ref.from, ref.to, "marker");
					else marks.push({ kind: "rule", from: ref.from, to: ref.to });
					return false;
				}
				if (name === "FencedCode") {
					lines(ref.from, ref.to, "codeblock", range);
					for (const part of children(ref.node)) {
						if (part.name === "CodeMark" || part.name === "CodeInfo") {
							style(part.from, part.to, "marker");
						}
					}
					return false;
				}
				if (name === "CodeBlock" || RAW_BLOCKS.has(name)) {
					lines(ref.from, ref.to, "codeblock", range);
					return false;
				}
				if (
					MUTED_BLOCKS.has(name) ||
					name === "HTMLTag" ||
					name === "Comment" ||
					name === "Image"
				) {
					style(ref.from, ref.to, "marker");
					return false;
				}
				const inline = INLINE_STYLES[name];
				if (inline) {
					style(ref.from, ref.to, inline);
					return true;
				}
				if (INLINE_MARKS.has(name) && parent) {
					if (touches(selection, parent.from, parent.to)) style(ref.from, ref.to, "marker");
					else hide(ref.from, ref.to);
					return false;
				}
				if (name === "Link") {
					link(ref.node);
					return true;
				}
				if (name === "Autolink") {
					autolink(ref.node);
					return false;
				}
				if (LINK_PARTS.has(name)) {
					if (name === "URL" && parent?.name !== "Link") {
						style(ref.from, ref.to, "link", bareHref(doc.sliceString(ref.from, ref.to)));
					}
					return false;
				}
				if (name === "Escape") {
					if (!touches(selection, ref.from, ref.to)) {
						hide(ref.from, ref.from + 1);
					}
					return false;
				}
				return true;
			},
		});
	}
	const seen = new Set<string>();
	return marks.filter((mark) => {
		const key =
			mark.kind === "line"
				? `line:${mark.at}:${mark.style}`
				: `${mark.kind}:${mark.from}:${mark.to}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
