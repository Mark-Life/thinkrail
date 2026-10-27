import { describe, expect, test } from "bun:test";
import { Text } from "@codemirror/state";
import { frontmatterBlock, liveBlocks } from "./blocks";
import { markdownParser } from "./language";
import { liveMarks } from "./markers";

function blocks(source: string, caret: number | null) {
	return liveBlocks({
		tree: markdownParser.parse(source),
		doc: Text.of(source.split("\n")),
		selection: caret === null ? null : [{ from: caret, to: caret }],
	});
}

const TABLE = "| a | b |\n| - | - |\n| 1 | 2 |";

describe("live blocks", () => {
	test("a table is a widget while the caret is outside it and source inside it", () => {
		const source = `intro\n\n${TABLE}\n\nafter`;
		const table = { kind: "table" as const, from: 7, to: 7 + TABLE.length, source: TABLE };
		expect(blocks(source, 0)).toEqual([table]);
		expect(blocks(source, null)).toEqual([table]);
		expect(blocks(source, 10)).toEqual([]);
		expect(blocks(source, 7 + TABLE.length)).toEqual([]);
	});

	test("an alert quote is a widget and a plain quote is not", () => {
		const source = "> [!NOTE]\n> Useful.\n\n> plain quote";
		expect(blocks(source, null)).toEqual([
			{ kind: "alert", from: 0, to: 19, source: "> [!NOTE]\n> Useful." },
		]);
	});

	test("fenced code, mermaid included, renders through the host", () => {
		const source = "```mermaid\nflowchart TD; A --> B\n```\n\n```ts\nconst a = 1;\n```";
		expect(blocks(source, null).map((block) => [block.kind, block.source])).toEqual([
			["code", "```mermaid\nflowchart TD; A --> B\n```"],
			["code", "```ts\nconst a = 1;\n```"],
		]);
	});

	test("an HTML block and an image-only paragraph are widgets", () => {
		const source =
			'<p align="center">\n<img src="logo.png">\n</p>\n\n![logo](logo.png)\n\ntext ![x](y.png)';
		expect(blocks(source, null).map((block) => block.kind)).toEqual(["html", "image"]);
	});

	test("a block nested in a list renders dedented", () => {
		const source = "- item\n\n  ```sh\n  echo hi\n  ```";
		expect(blocks(source, null)).toEqual([
			{ kind: "code", from: 8, to: source.length, source: "```sh\necho hi\n```" },
		]);
	});

	test("a block inside a quote stays source", () => {
		expect(blocks(`> ${TABLE.replaceAll("\n", "\n> ")}`, null)).toEqual([]);
	});

	test("front matter is a summary widget and its lines never parse as markdown", () => {
		const source = "---\nid: one\ntitle: Two\n---\n# Goal\n";
		const front = { kind: "frontmatter" as const, from: 0, to: 26, source: "id: one\ntitle: Two" };
		expect(frontmatterBlock(Text.of(source.split("\n")))).toEqual(front);
		expect(blocks(source, null)).toEqual([front]);
		expect(blocks(source, 5)).toEqual([]);
		const doc = Text.of(source.split("\n"));
		const marks = liveMarks({
			tree: markdownParser.parse(source),
			doc,
			ranges: [{ from: 0, to: doc.length }],
			selection: [{ from: 5, to: 5 }],
			raw: [front],
		});
		expect(marks.filter((mark) => mark.kind === "line")).toEqual([
			{ kind: "line", at: 0, style: "codeblock" },
			{ kind: "line", at: 4, style: "codeblock" },
			{ kind: "line", at: 12, style: "codeblock" },
			{ kind: "line", at: 23, style: "codeblock" },
			{ kind: "line", at: 27, style: "h1" },
		]);
	});

	test("syntax that starts inside front matter never runs into the body", () => {
		const fence = "---\nnote: |\n  ```\n---\n# Heading\n\nSome **bold**\n";
		const doc = Text.of(fence.split("\n"));
		const tree = markdownParser.parse(fence);
		expect(blocks(fence, null).map((block) => block.kind)).toEqual(["frontmatter"]);
		const list = liveMarks({
			tree,
			doc,
			ranges: [{ from: 0, to: doc.length }],
			selection: null,
			skip: blocks(fence, null),
		});
		expect(list).toContainEqual({ kind: "line", at: 22, style: "h1" });
		expect(
			list.filter((mark) => mark.kind === "hide").map((mark) => fence.slice(mark.from, mark.to)),
		).toEqual(["# ", "**", "**"]);

		const dots = "---\ntitle: x\n...\nBody **bold** line\n";
		const dotDoc = Text.of(dots.split("\n"));
		const hidden = liveMarks({
			tree: markdownParser.parse(dots),
			doc: dotDoc,
			ranges: [{ from: 0, to: dotDoc.length }],
			selection: null,
			skip: blocks(dots, null),
		}).filter((mark) => mark.kind === "hide");
		expect(hidden.map((mark) => dots.slice(mark.from, mark.to))).toEqual(["**", "**"]);
	});

	test("an unclosed front matter fence is plain markdown", () => {
		expect(frontmatterBlock(Text.of(["---", "id: one"]))).toBeNull();
	});
});

describe("reference definitions", () => {
	test("tables, alerts and images carry the document's definitions, code does not", () => {
		const source =
			'![shot][s]\n\n| a |\n| - |\n| [site][s] |\n\n> [!NOTE]\n> see [docs][s]\n\n```\n[s]\n```\n\n[s]: https://example.com "Site"';
		const definition = '[s]: https://example.com "Site"';
		expect(blocks(source, null).map((block) => block.source)).toEqual([
			`![shot][s]\n\n${definition}`,
			`| a |\n| - |\n| [site][s] |\n\n${definition}`,
			`> [!NOTE]\n> see [docs][s]\n\n${definition}`,
			"```\n[s]\n```",
		]);
	});
});

describe("live blocks across blank lines and tabs", () => {
	test("an HTML element split by blank lines is one widget with its markdown body", () => {
		const details = "<details>\n<summary>S</summary>\n\nbody\n\n</details>";
		expect(blocks(`${details}\n\nafter\n`, null)).toEqual([
			{ kind: "html", from: 0, to: details.length, source: details },
		]);
		const centered = "<div align=center>\n\n![x](a.png)\n\n</div>";
		expect(blocks(`${centered}\n`, null).map((block) => [block.kind, block.source])).toEqual([
			["html", centered],
		]);
	});

	test("nested same tags close at the matching end, and an unclosed tag stays alone", () => {
		const nested = "<div>\n<div>\n\ninner\n\n</div>\n\nouter\n\n</div>";
		expect(blocks(`${nested}\n\n<div>x</div>\n`, null).map((block) => block.source)).toEqual([
			nested,
			"<div>x</div>",
		]);
		expect(blocks("<details>\n<summary>S</summary>\n\nbody\n", null).map((b) => b.source)).toEqual([
			"<details>\n<summary>S</summary>",
		]);
		expect(blocks("<img src=a.png>\n\ntext\n\n</div>\n", null).map((b) => b.source)).toEqual([
			"<img src=a.png>",
			"</div>",
		]);
	});

	test("a tab-indented fence in a list item dedents to a fence", () => {
		expect(blocks("- item\n\t```js\n\tcode\n\t```\n", null)).toEqual([
			{ kind: "code", from: 7, to: 24, source: "```js\ncode\n```" },
		]);
	});
});
