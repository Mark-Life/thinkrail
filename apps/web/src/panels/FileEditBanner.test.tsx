import { expect, test } from "bun:test";
import { CONFLICT_CHOICES } from "@thinkrail/resource-renderers";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileBufferSummary } from "../store";
import { FileEditBanner, historyCommand } from "./FileEditBanner";

const render = (summary: FileBufferSummary | undefined) =>
	renderToStaticMarkup(
		<FileEditBanner
			summary={summary}
			onReload={() => {}}
			onKeepMine={() => {}}
			onResolveFirst={() => {}}
			onHistory={() => {}}
		/>,
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
	expect(render({ status: "error", dirty: true, error: "failed" })).toContain(
		'aria-live="assertive"',
	);
});

test("an open conflict offers Mine, Theirs and Both outside the editor", () => {
	const html = render({ status: "conflict", dirty: true, conflicts: 2 });
	expect(html).toContain('aria-label="First change that also changed on disk"');
	const offered = [...html.matchAll(/data-testid="file-edit-resolve-(\w+)"/g)].map(
		(match) => match[1],
	);
	expect(offered).toEqual([...CONFLICT_CHOICES]);
	expect(render({ status: "stale", dirty: true })).not.toContain("file-edit-resolve-");
});

test("Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z in the banner map to the file's undo and redo", () => {
	const key = (key: string, mods: Partial<KeyboardEvent> = {}) => ({
		key,
		code: `Key${key.toUpperCase()}`,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		altKey: false,
		...mods,
	});
	expect(historyCommand(key("z", { metaKey: true }), "MacIntel")).toBe("undo");
	expect(historyCommand(key("Z", { metaKey: true, shiftKey: true }), "MacIntel")).toBe("redo");
	expect(historyCommand(key("z", { ctrlKey: true }), "Win32")).toBe("undo");
	expect(historyCommand(key("z", { ctrlKey: true }), "MacIntel")).toBeNull();
	expect(historyCommand(key("z", { ctrlKey: true, altKey: true }), "Win32")).toBeNull();
	expect(historyCommand(key("y", { ctrlKey: true }), "Win32")).toBeNull();
});

test("the banner undo chord falls back to the Z key only when the layout types a non-Latin letter", () => {
	const ctrl = { ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
	expect(historyCommand({ ...ctrl, key: "я", code: "KeyZ" }, "Win32")).toBe("undo");
	expect(historyCommand({ ...ctrl, key: "Я", code: "KeyZ", shiftKey: true }, "Win32")).toBe("redo");
	expect(historyCommand({ ...ctrl, key: "w", code: "KeyZ" }, "Win32")).toBeNull();
	expect(historyCommand({ ...ctrl, key: "z", code: "KeyW" }, "Win32")).toBe("undo");
});
