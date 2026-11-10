import { describe, expect, it } from "bun:test";
import type { ToolInputs } from "@thinkrail/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditCard } from "./EditCard";

function markup(args: Record<string, unknown>): string {
	return renderToStaticMarkup(
		createElement(EditCard, {
			toolCallId: "edit-call",
			toolName: "edit",
			args,
			result: { content: [{ type: "text", text: "ok" }] },
			status: "done",
			workspaceRoot: "/repo",
			streaming: false,
		}),
	);
}

describe("EditCard", () => {
	it("shows every replacement of pi's edits array", () => {
		const args: ToolInputs["edit"] = {
			path: "README.md",
			edits: [
				{ oldText: "first old", newText: "first new" },
				{ oldText: "second old", newText: "second new" },
			],
		};
		const html = markup({ ...args });
		for (const text of ["first old", "first new", "second old", "second new"]) {
			expect(html).toContain(text);
		}
	});

	it("shows the single replacement of the legacy top-level form", () => {
		const html = markup({ path: "README.md", oldText: "before", newText: "after" });
		expect(html).toContain("before");
		expect(html).toContain("after");
	});

	it("skips edits a still-streaming call has not finished", () => {
		const html = markup({ path: "README.md", edits: [{ oldText: "kept", newText: "done" }, {}] });
		expect(html).toContain("kept");
		expect(html).toContain("done");
	});
});
