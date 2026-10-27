import { describe, expect, test } from "bun:test";
import { Text } from "@codemirror/state";
import { markdownParser } from "./language";
import { type LiveMark, liveMarks, touches } from "./markers";

function marks(source: string, caret: number | null): LiveMark[] {
	const doc = Text.of(source.split("\n"));
	return liveMarks({
		tree: markdownParser.parse(source),
		doc,
		ranges: [{ from: 0, to: doc.length }],
		selection: caret === null ? null : [{ from: caret, to: caret }],
	});
}

function cut(source: string, list: readonly LiveMark[]) {
	return list
		.filter((mark) => mark.kind === "hide")
		.map((mark) => source.slice(mark.from, mark.to));
}

function styled(source: string, list: readonly LiveMark[], style: string) {
	return list.flatMap((mark) =>
		mark.kind === "style" && mark.style === style ? [source.slice(mark.from, mark.to)] : [],
	);
}

describe("touches", () => {
	test("counts a caret at either edge of a node", () => {
		expect(touches([{ from: 3, to: 3 }], 3, 8)).toBe(true);
		expect(touches([{ from: 8, to: 8 }], 3, 8)).toBe(true);
		expect(touches([{ from: 9, to: 9 }], 3, 8)).toBe(false);
		expect(touches(null, 0, 100)).toBe(false);
	});
});

describe("heading markers", () => {
	const source = "intro\n\n## Title\n";
	test("hide with their space when the caret is on another line", () => {
		const list = marks(source, 0);
		expect(cut(source, list)).toEqual(["## "]);
		expect(list).toContainEqual({ kind: "line", at: 7, style: "h2" });
	});
	test("show as a muted marker when the caret is on the heading line", () => {
		const list = marks(source, source.indexOf("Title") + 2);
		expect(cut(source, list)).toEqual([]);
		expect(styled(source, list, "marker")).toEqual(["##"]);
	});
	test("a closing sequence hides with the spaces before it", () => {
		const closed = "# Title ##\n\nnext";
		expect(cut(closed, marks(closed, closed.length))).toEqual(["# ", " ##"]);
	});
});

describe("inline markers", () => {
	const source = "say **bold** and _em_ and `code` and ~~gone~~ here";
	test("hide everywhere while the caret is outside their node", () => {
		const list = marks(source, 0);
		expect(cut(source, list)).toEqual(["**", "**", "_", "_", "`", "`", "~~", "~~"]);
		expect(styled(source, list, "strong")).toEqual(["**bold**"]);
		expect(styled(source, list, "em")).toEqual(["_em_"]);
		expect(styled(source, list, "code")).toEqual(["`code`"]);
		expect(styled(source, list, "strike")).toEqual(["~~gone~~"]);
	});
	test("show only for the node the caret is in", () => {
		const list = marks(source, source.indexOf("bold") + 1);
		expect(cut(source, list)).toEqual(["_", "_", "`", "`", "~~", "~~"]);
		expect(styled(source, list, "marker")).toEqual(["**", "**"]);
	});
	test("a selection that reaches into a node shows its markers", () => {
		const doc = Text.of([source]);
		const list = liveMarks({
			tree: markdownParser.parse(source),
			doc,
			ranges: [{ from: 0, to: doc.length }],
			selection: [{ from: 0, to: source.indexOf("em") }],
		});
		expect(cut(source, list)).toEqual(["`", "`", "~~", "~~"]);
	});
	test("an unfocused editor hides every marker", () => {
		const doc = "# Head\n\n- **x**";
		expect(cut(doc, marks(doc, null))).toEqual(["# ", "**", "**"]);
	});
	test("an escape hides its backslash off the caret", () => {
		const doc = "a \\* b";
		expect(cut(doc, marks(doc, 3))).toEqual([]);
		expect(cut(doc, marks(doc, doc.length))).toEqual(["\\"]);
	});
});

describe("links", () => {
	const source = 'see [the spec](docs/spec.md "Spec") now';
	test("off the caret keep only the text, styled as a link with its target", () => {
		const list = marks(source, 0);
		expect(cut(source, list)).toEqual(["[", "]", "(", "docs/spec.md", '"Spec"', ")"]);
		expect(list).toContainEqual({
			kind: "style",
			from: source.indexOf("the spec"),
			to: source.indexOf("the spec") + "the spec".length,
			style: "link",
			href: "docs/spec.md",
		});
	});
	test("with the caret inside show the brackets and the target", () => {
		const list = marks(source, source.indexOf("spec") + 1);
		expect(cut(source, list)).toEqual([]);
		expect(styled(source, list, "marker")).toEqual(["[", "]", "(", "docs/spec.md", '"Spec"', ")"]);
	});
	test("a bare www address links over https", () => {
		const doc = "go to www.example.com today";
		const link = marks(doc, 0).find((mark) => mark.kind === "style" && mark.style === "link");
		expect(link).toMatchObject({ href: "https://www.example.com" });
	});
	test("a title or label that spans lines hides line by line, never across a break", () => {
		for (const doc of [
			'a [x](http://e.com "t1\nt2") b\n',
			"a [x][long\nlabel] b\n\n[long label]: http://e.com\n",
		]) {
			const hidden = cut(doc, marks(doc, null));
			expect(hidden.length).toBeGreaterThan(0);
			expect(hidden.some((text) => text.includes("\n"))).toBe(false);
		}
	});
	test("brackets with no target stay literal text", () => {
		const doc = "array[0] and see [1] or [WIP] x [^1]\n";
		const list = marks(doc, null);
		expect(cut(doc, list)).toEqual([]);
		expect(styled(doc, list, "link")).toEqual([]);
	});
	test("a reference link takes its target from the definition", () => {
		const doc =
			"see [Docs] and [the guide][g] and [g][]\n\n[docs]: <https://d.dev>\n[G]: https://g.dev\n";
		const links = marks(doc, null).flatMap((mark) =>
			mark.kind === "style" && mark.style === "link"
				? [[doc.slice(mark.from, mark.to), mark.href]]
				: [],
		);
		expect(links).toEqual([
			["Docs", "https://d.dev"],
			["the guide", "https://g.dev"],
			["g", "https://g.dev"],
		]);
	});
	test("an autolink hides its angle brackets off the caret", () => {
		const doc = "a <https://x.dev> b\n\nnext";
		expect(cut(doc, marks(doc, doc.length))).toEqual(["<", ">"]);
	});
});

describe("line markers", () => {
	test("a bullet draws as a widget off its line and shows as text on it", () => {
		const source = "- one\n- two";
		const off = marks(source, source.length);
		expect(off).toContainEqual({ kind: "bullet", from: 0, to: 1 });
		expect(off.filter((mark) => mark.kind === "bullet")).toHaveLength(1);
		expect(styled(source, off, "marker")).toEqual(["-"]);
	});
	test("ordered list numbers stay as typed", () => {
		const source = "1. one\n2. two";
		const list = marks(source, null);
		expect(list.filter((mark) => mark.kind !== "line")).toEqual([]);
	});
	test("a task box is a checkbox off its line", () => {
		const source = "- [x] done\n- [ ] todo";
		const list = marks(source, source.length);
		expect(list).toContainEqual({ kind: "task", from: 2, to: 5, checked: true, label: "done" });
		expect(cut(source, list)).toEqual(["- "]);
		expect(styled(source, list, "marker")).toEqual(["-", "[ ]"]);
	});
	test("a task box is named by its item's text, without markup", () => {
		const source = "- [ ] write **the** [docs](a.md) `now`\n- [x] ship\n- [ ]   \nend";
		const labels = marks(source, source.length).flatMap((mark) =>
			mark.kind === "task" ? [mark.label] : [],
		);
		expect(labels).toEqual(["write the docs now", "ship", ""]);
	});
	test("a quote marker hides with its space and styles every line", () => {
		const source = "> one\n> two\n\nafter";
		const list = marks(source, source.length);
		expect(cut(source, list)).toEqual(["> ", "> "]);
		expect(list.filter((mark) => mark.kind === "line")).toEqual([
			{ kind: "line", at: 0, style: "quote" },
			{ kind: "line", at: 6, style: "quote" },
		]);
	});
	test("a rule draws as a widget off its line", () => {
		const source = "a\n\n---\n\nb";
		expect(marks(source, 0)).toContainEqual({ kind: "rule", from: 3, to: 6 });
		expect(styled(source, marks(source, 4), "marker")).toEqual(["---"]);
	});
	test("fenced code lines are code and keep their fences as muted markers", () => {
		const source = "```ts\nconst a = 1;\n```";
		const list = marks(source, 8);
		expect(list.filter((mark) => mark.kind === "line")).toHaveLength(3);
		expect(styled(source, list, "marker")).toEqual(["```", "ts", "```"]);
		expect(cut(source, list)).toEqual([]);
	});
});

describe("nested inline styles", () => {
	test("code or bold that fills a link label keeps its own style", () => {
		const code = "See [`run()`](api.md) now";
		const coded = marks(code, null);
		expect(styled(code, coded, "link")).toEqual(["`run()`"]);
		expect(styled(code, coded, "code")).toEqual(["`run()`"]);
		const bold = "See [**bold**](api.md) now";
		const bolded = marks(bold, null);
		expect(styled(bold, bolded, "link")).toEqual(["**bold**"]);
		expect(styled(bold, bolded, "strong")).toEqual(["**bold**"]);
	});
});

describe("quoted fences", () => {
	test("every quote mark of a fence inside a quote hides off the caret", () => {
		const source = "> ```js\n> a\n> ```\n";
		expect(cut(source, marks(source, null))).toEqual(["> ", "> ", "> "]);
		const onFirst = marks(source, 0);
		expect(styled(source, onFirst, "marker")).toContain(">");
		expect(cut(source, onFirst)).toEqual(["> ", "> "]);
	});
});

describe("skipped blocks", () => {
	test("nodes inside a block widget get no marks", () => {
		const source = "**a**\n\n**b**";
		const doc = Text.of(source.split("\n"));
		const list = liveMarks({
			tree: markdownParser.parse(source),
			doc,
			ranges: [{ from: 0, to: doc.length }],
			selection: null,
			skip: [{ from: 7, to: 12 }],
		});
		expect(cut(source, list)).toEqual(["**", "**"]);
		expect(list.every((mark) => !("from" in mark) || mark.to <= 5)).toBe(true);
	});
});
