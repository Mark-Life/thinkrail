import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { markdownLanguage } from "./language";
import { linkTarget } from "./links";

const state = (doc: string) => EditorState.create({ doc, extensions: markdownLanguage });

describe("linkTarget", () => {
	const doc = state("# Intro\n\n## Section two ##\n\nbody");

	test("a link resolves to a heading line, another file, or an outside page", () => {
		expect(linkTarget(doc, "docs/a.md", "#section-two")).toEqual({ kind: "line", line: 3 });
		expect(linkTarget(doc, "docs/a.md", "#missing")).toBeNull();
		expect(linkTarget(doc, "docs/a.md", "../b.md#x")).toEqual({ kind: "file", path: "b.md" });
		expect(linkTarget(doc, "docs/a.md", "../../escape.md")).toBeNull();
		expect(linkTarget(doc, "docs/a.md", "https://x.dev")).toEqual({
			kind: "external",
			href: "https://x.dev",
		});
		expect(linkTarget(doc, "docs/a.md", "mailto:a@x.dev")).toEqual({
			kind: "external",
			href: "mailto:a@x.dev",
		});
		expect(linkTarget(doc, "docs/a.md", "")).toBeNull();
	});

	test("only http, https and mailto leave the app", () => {
		for (const href of [
			"javascript:alert(1)",
			"JavaScript:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"vbscript:x",
			"file:///etc/passwd",
		]) {
			expect(linkTarget(doc, "a.md", href)).toBeNull();
		}
	});

	test("anchors match the reading view's heading ids", () => {
		const doc = state(
			"```sh\n# setup\n```\n\n## Setup\n\n## Setup\n\n## See [docs](x.md)\n\nPlain *em* `code`\n---\n",
		);
		expect(linkTarget(doc, "a.md", "#setup")).toEqual({ kind: "line", line: 5 });
		expect(linkTarget(doc, "a.md", "#setup-1")).toEqual({ kind: "line", line: 7 });
		expect(linkTarget(doc, "a.md", "#see-docs")).toEqual({ kind: "line", line: 9 });
		expect(linkTarget(doc, "a.md", "#see-docsxmd")).toBeNull();
		expect(linkTarget(doc, "a.md", "#plain-em-code")).toEqual({ kind: "line", line: 11 });
	});

	test("front matter is not a heading", () => {
		const doc = state("---\ntitle: x\n---\n\n# Title\n");
		expect(linkTarget(doc, "a.md", "#title-x")).toBeNull();
		expect(linkTarget(doc, "a.md", "#title")).toEqual({ kind: "line", line: 5 });
	});
});
