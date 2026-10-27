import { defineLanguageFacet, Language, languageDataProp } from "@codemirror/language";
import { type Input, Parser, type PartialParse, type Tree, type TreeFragment } from "@lezer/common";
import { GFM, parser } from "@lezer/markdown";

const FRONTMATTER_OPEN = /^---[ \t]*$/;
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*$/;

export function frontmatterClose(lines: Iterable<string>): number | null {
	let index = 0;
	for (const line of lines) {
		if (index === 0 && !FRONTMATTER_OPEN.test(line)) return null;
		if (index >= 2 && FRONTMATTER_CLOSE.test(line)) return index;
		index += 1;
	}
	return null;
}

function frontmatterEnd(input: Input): number {
	if (input.read(0, Math.min(input.length, 3)) !== "---") return 0;
	const lines = input.read(0, input.length).split("\n");
	const close = frontmatterClose(lines);
	if (close === null) return 0;
	return lines.slice(0, close + 1).reduce((end, line) => end + line.length + 1, -1);
}

const blank = (text: string) => text.replace(/[^\n]/g, " ");

function maskedInput(input: Input, end: number): Input {
	const read = (from: number, to: number) =>
		from >= end
			? input.read(from, to)
			: blank(input.read(from, Math.min(to, end))) + (to > end ? input.read(end, to) : "");
	return {
		length: input.length,
		lineChunks: false,
		chunk: (from) => (from < end ? read(from, end) : input.chunk(from)),
		read,
	};
}

const data = defineLanguageFacet();

const gfmParser = parser.configure([GFM, { props: [languageDataProp.add({ Document: data })] }]);

const maskedEnds = new WeakMap<Tree, number>();

class FrontmatterParser extends Parser {
	createParse(
		input: Input,
		fragments: readonly TreeFragment[],
		ranges: readonly { from: number; to: number }[],
	): PartialParse {
		const end = frontmatterEnd(input);
		const parse = gfmParser.createParse(
			end > 0 ? maskedInput(input, end) : input,
			fragments.filter((fragment) => maskedEnds.get(fragment.tree) === end),
			ranges,
		);
		return {
			advance: () => {
				const tree = parse.advance();
				if (tree) maskedEnds.set(tree, end);
				return tree;
			},
			get parsedPos() {
				return parse.parsedPos;
			},
			stopAt: (pos) => parse.stopAt(pos),
			get stoppedAt() {
				return parse.stoppedAt;
			},
		};
	}
}

export const markdownParser = new FrontmatterParser();

export const markdownLanguage = new Language(data, markdownParser, [], "markdown");
