import type { Text } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";
import { parseAlertMarker } from "../markdownAlerts";
import { type Span, touches } from "./markers";

type LiveBlockKind = "table" | "alert" | "code" | "html" | "image" | "frontmatter";

export interface LiveBlock extends Span {
	kind: LiveBlockKind;
	source: string;
}

const FRONTMATTER_OPEN = /^---[ \t]*$/;
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*$/;
const CONTAINERS = new Set(["BulletList", "OrderedList", "ListItem"]);

const frontmatterCache = new WeakMap<Text, LiveBlock | null>();
const candidateCache = new WeakMap<Text, { tree: Tree; blocks: readonly LiveBlock[] }>();

function findFrontmatter(doc: Text): LiveBlock | null {
	if (doc.lines < 3 || !FRONTMATTER_OPEN.test(doc.line(1).text)) return null;
	for (let number = 3; number <= doc.lines; number += 1) {
		const line = doc.line(number);
		if (FRONTMATTER_CLOSE.test(line.text)) {
			const source = doc.sliceString(doc.line(2).from, doc.line(number - 1).to);
			return { kind: "frontmatter", from: 0, to: line.to, source };
		}
	}
	return null;
}

export function frontmatterBlock(doc: Text): LiveBlock | null {
	const cached = frontmatterCache.get(doc);
	if (cached !== undefined) return cached;
	const found = findFrontmatter(doc);
	frontmatterCache.set(doc, found);
	return found;
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

function blockCandidates(tree: Tree, doc: Text): readonly LiveBlock[] {
	const cached = candidateCache.get(doc);
	if (cached?.tree === tree) return cached.blocks;
	const blocks: LiveBlock[] = [];
	const front = frontmatterBlock(doc);
	if (front) blocks.push(front);
	const place = (node: SyntaxNode, kind: LiveBlockKind) => {
		const first = doc.lineAt(node.from);
		const last = doc.lineAt(node.to);
		if (doc.sliceString(first.from, node.from).trim() !== "") return;
		if (doc.sliceString(node.to, last.to).trim() !== "") return;
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
	candidateCache.set(doc, { tree, blocks });
	return blocks;
}

export function liveBlocks({
	tree,
	doc,
	selection,
	keep = [],
}: {
	tree: Tree;
	doc: Text;
	selection: readonly Span[] | null;
	keep?: readonly Span[];
}): LiveBlock[] {
	return blockCandidates(tree, doc).filter(
		(block) => !touches(selection, block.from, block.to) && !touches(keep, block.from, block.to),
	);
}
