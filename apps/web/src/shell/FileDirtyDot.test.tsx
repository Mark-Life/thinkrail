import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FileSaveMark } from "./FileDirtyDot";

const render = (indicator: "unsaved" | "saving" | "pending", autosaving: boolean) =>
	renderToStaticMarkup(<FileSaveMark indicator={indicator} autosaving={autosaving} />);

test("autosave's ring says a write is coming apart from one already running", () => {
	expect(render("pending", true)).toContain('aria-label="Saving soon"');
	expect(render("saving", true)).toContain('aria-label="Saving"');
	expect(render("saving", true)).toContain('data-testid="file-save-pending"');
	expect(render("unsaved", true)).toContain('aria-label="Unsaved changes, autosave paused"');
});

test("manual mode keeps the unsaved dot, pulsing while saving", () => {
	expect(render("saving", false)).toContain('data-testid="file-dirty-dot"');
	expect(render("unsaved", false)).toContain('aria-label="Unsaved changes"');
});
