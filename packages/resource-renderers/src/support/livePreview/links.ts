import type { Text } from "@codemirror/state";
import { classifyHref, relativePathname, resolveRelativePath, slugify } from "../markdownLinks";

export type LinkTarget =
	| { kind: "line"; line: number }
	| { kind: "external"; href: string }
	| { kind: "file"; path: string };

function headingLine(doc: Text, slug: string): number | null {
	for (let number = 1; number <= doc.lines; number += 1) {
		const heading = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(doc.line(number).text);
		if (heading && slugify(heading[1] ?? "") === slug) return number;
	}
	return null;
}

export function linkTarget(doc: Text, path: string, href: string): LinkTarget | null {
	switch (classifyHref(href)) {
		case "anchor": {
			let slug: string;
			try {
				slug = decodeURIComponent(href.slice(1));
			} catch {
				return null;
			}
			const line = headingLine(doc, slug);
			return line === null ? null : { kind: "line", line };
		}
		case "external":
			return { kind: "external", href };
		case "relative": {
			const target = resolveRelativePath(path, relativePathname(href));
			return target ? { kind: "file", path: target } : null;
		}
		default:
			return null;
	}
}
