import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { classifyHref, relativePathname, resolveRelativePath, slugify } from "../markdownLinks";
import { frontmatterBlock } from "./blocks";
import { liveMarks } from "./markers";

type LinkTarget =
	| { kind: "line"; line: number }
	| { kind: "external"; href: string }
	| { kind: "file"; path: string };

const HEADING = /^(?:ATX|Setext)Heading[1-6]$/;
const HEADING_CONTAINERS = new Set([
	"Document",
	"Blockquote",
	"BulletList",
	"OrderedList",
	"ListItem",
]);
const MARKUP = new Set([
	"HeaderMark",
	"EmphasisMark",
	"CodeMark",
	"StrikethroughMark",
	"LinkMark",
	"LinkTitle",
	"LinkLabel",
	"Image",
]);
const SAFE_SCHEME = /^(?:https?:|mailto:|\/\/)/i;

function headingText(state: EditorState, heading: SyntaxNode): string {
	let text = "";
	let at = heading.from;
	const skip = (from: number, to: number) => {
		text += state.doc.sliceString(at, from);
		at = to;
	};
	const walk = (node: SyntaxNode) => {
		for (let child = node.firstChild; child; child = child.nextSibling) {
			if (MARKUP.has(child.name) || (child.name === "URL" && node.name === "Link")) {
				skip(child.from, child.to);
			} else if (child.name === "Escape") skip(child.from, child.from + 1);
			else walk(child);
		}
	};
	walk(heading);
	return text + state.doc.sliceString(at, heading.to);
}

function headingLine(state: EditorState, slug: string): number | null {
	const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
	const front = frontmatterBlock(state.doc);
	const seen = new Map<string, number>();
	let found: number | null = null;
	tree.iterate({
		enter: (ref) => {
			if (found !== null) return false;
			if (HEADING.test(ref.name)) {
				if (front && ref.from < front.to) return false;
				const base = slugify(headingText(state, ref.node));
				if (!base) return false;
				const count = seen.get(base) ?? 0;
				seen.set(base, count + 1);
				if ((count === 0 ? base : `${base}-${count}`) === slug) {
					found = state.doc.lineAt(ref.from).number;
				}
				return false;
			}
			return HEADING_CONTAINERS.has(ref.name);
		},
	});
	return found;
}

export function linkTarget(state: EditorState, path: string, href: string): LinkTarget | null {
	switch (classifyHref(href)) {
		case "anchor": {
			let slug: string;
			try {
				slug = decodeURIComponent(href.slice(1));
			} catch {
				return null;
			}
			const line = headingLine(state, slug);
			return line === null ? null : { kind: "line", line };
		}
		case "external":
			return SAFE_SCHEME.test(href) ? { kind: "external", href } : null;
		case "relative": {
			const target = resolveRelativePath(path, relativePathname(href));
			return target ? { kind: "file", path: target } : null;
		}
		default:
			return null;
	}
}

export function linkHrefAt(state: EditorState, pos: number): string | null {
	const line = state.doc.lineAt(pos);
	const marks = liveMarks({
		tree: syntaxTree(state),
		doc: state.doc,
		ranges: [{ from: line.from, to: line.to }],
		selection: null,
	});
	for (const mark of marks) {
		if (mark.kind === "style" && mark.href && mark.from <= pos && pos <= mark.to) return mark.href;
	}
	return null;
}
