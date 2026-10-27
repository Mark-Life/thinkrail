import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileBufferSummary } from "../store";
import { FileEditBanner } from "./FileEditBanner";

const render = (summary: FileBufferSummary | undefined) =>
	renderToStaticMarkup(
		<FileEditBanner summary={summary} onReload={() => {}} onKeepMine={() => {}} />,
	);

test("the live region is mounted before any issue, so its text change is announced", () => {
	const clean = render({ status: "dirty", dirty: true });
	expect(clean).toContain('role="status"');
	expect(clean).not.toContain('data-testid="file-edit-banner"');

	const deleted = render({ status: "deleted", dirty: false });
	expect(deleted).toMatch(/role="status" aria-live="polite"[^>]*>Deleted on disk/);
	expect(deleted).toContain('data-status="deleted"');
});

test("a conflict or a failed save is announced assertively", () => {
	expect(render({ status: "stale", dirty: true })).toContain('aria-live="assertive"');
	expect(render({ status: "conflict", dirty: true, conflicts: 2 })).toContain(
		'aria-live="assertive"',
	);
	expect(render({ status: "error", dirty: true, error: "failed" })).toContain(
		'aria-live="assertive"',
	);
});
