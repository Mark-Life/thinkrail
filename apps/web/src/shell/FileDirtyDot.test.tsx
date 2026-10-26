import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FileSaveMark } from "./FileDirtyDot";

const render = (
	indicator: "unsaved" | "saving" | "pending",
	autosaving: boolean,
	mode: "auto" | "manual",
) =>
	renderToStaticMarkup(<FileSaveMark indicator={indicator} autosaving={autosaving} mode={mode} />);

test("autosave's ring says a write is coming apart from one already running", () => {
	expect(render("pending", true, "auto")).toContain('aria-label="Saving soon"');
	expect(render("saving", true, "auto")).toContain('aria-label="Saving"');
	expect(render("saving", true, "auto")).toContain('data-testid="file-save-pending"');
	expect(render("unsaved", false, "auto")).toContain(
		'aria-label="Unsaved changes, autosave paused"',
	);
});

test("manual mode keeps the unsaved dot, pulsing while saving", () => {
	expect(render("saving", false, "manual")).toContain('data-testid="file-dirty-dot"');
	expect(render("unsaved", false, "manual")).toContain('aria-label="Unsaved changes"');
});
