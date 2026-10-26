import type { Text } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";
import { parseAlertMarker } from "../markdownAlerts";
import { type Span, touches } from "./markers";

export type LiveBlockKind = "table" | "alert" | "code" | "html" | "image" | "frontmatter";

export interface LiveBlock extends Span {
	kind: LiveBlockKind;
	source: string;
}

const FRONTMATTER = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/;
const CONTAINERS = new Set(["BulletList", "OrderedList", "ListItem"]);

export function frontmatterBlock(doc: Text): LiveBlock | null {
	if (doc.sliceString(0, 3) !== "---") return null;
	const match = FRONTMATTER.exec(doc.toString());
	if (!match) return null;
	const to = match[0].endsWith("\n") ? match[0].length - 1 : match[0].length;
	return { kind: "frontmatter", from: 0, to, source: match[1] ?? "" };
}

function dedent(text: string, columns: number): string {
	if (columns === 0) return text;
	const pattern = new RegExp(`^ {0,${columns}}`);
	return text
		.split("\n")
		.map((line) => line.replace(pattern, ""))
		.join("\n");
}

function blockKind(node: SyntaxNode, doc: Text): LiveBlockKind | null {
	switch (node.name) {
		case "Table":
			return "table";
		case "FencedCode":
			return "code";
		case "HTMLBlock":
			return "html";
		case "Blockquote": {
			const first = doc.lineAt(node.from);
			const body = doc.sliceString(node.from, first.to).replace(/^(?:[ \t]*>)+[ \t]?/, "");
			return parseAlertMarker(body) ? "alert" : null;
		}
		case "Paragraph": {
			const only = node.firstChild;
			return only?.name === "Image" &&
				!only.nextSibling &&
				doc.sliceString(node.from, node.to).trim() === doc.sliceString(only.from, only.to)
				? "image"
				: null;
		}
		default:
			return null;
	}
}

export function liveBlocks({
	tree,
	doc,
	selection,
}: {
	tree: Tree;
	doc: Text;
	selection: readonly Span[] | null;
}): LiveBlock[] {
	const blocks: LiveBlock[] = [];
	const front = frontmatterBlock(doc);
	if (front && !touches(selection, front.from, front.to)) blocks.push(front);
	const place = (node: SyntaxNode, kind: LiveBlockKind) => {
		const first = doc.lineAt(node.from);
		const last = doc.lineAt(node.to);
		if (doc.sliceString(first.from, node.from).trim() !== "") return;
		if (doc.sliceString(node.to, last.to).trim() !== "") return;
		if (touches(selection, first.from, last.to)) return;
		const source = dedent(doc.sliceString(first.from, last.to), node.from - first.from);
		blocks.push({ kind, from: first.from, to: last.to, source });
	};
	const visit = (parent: SyntaxNode) => {
		for (let node = parent.firstChild; node; node = node.nextSibling) {
			if (front && node.from <= front.to) continue;
			if (CONTAINERS.has(node.name)) {
				visit(node);
				continue;
			}
			const kind = blockKind(node, doc);
			if (kind) place(node, kind);
		}
	};
	visit(tree.topNode);
	return blocks;
}
