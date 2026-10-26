import { expect, test } from "bun:test";
import { Text } from "@codemirror/state";
import { linkTarget } from "./links";

const doc = Text.of(["# Intro", "", "## Section two ##", "", "body"]);

test("a link resolves to a heading line, another file, or an outside page", () => {
	expect(linkTarget(doc, "docs/a.md", "#section-two")).toEqual({ kind: "line", line: 3 });
	expect(linkTarget(doc, "docs/a.md", "#missing")).toBeNull();
	expect(linkTarget(doc, "docs/a.md", "../b.md#x")).toEqual({ kind: "file", path: "b.md" });
	expect(linkTarget(doc, "docs/a.md", "../../escape.md")).toBeNull();
	expect(linkTarget(doc, "docs/a.md", "https://x.dev")).toEqual({
		kind: "external",
		href: "https://x.dev",
	});
	expect(linkTarget(doc, "docs/a.md", "")).toBeNull();
});
