import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { banner, conflictLens, openFile, typeAtLineEnd, visibleEditor } from "./fixtures/fileEdit";
import { installNativeShortcuts, nativeCommand } from "./fixtures/nativeShortcuts";

const BASE = "const one = 1;\nconst two = 2;\nconst three = 3;\n";

test.beforeEach(async ({ page }) => {
	await installNativeShortcuts(page, "MacIntel");
});

test("Edit menu undo and redo reach the file's own history and keep a merged disk change", async ({
	page,
}) => {
	const path = await openFile(page, "menu.ts", BASE);
	await typeAtLineEnd(page, 3, " // mine");
	writeFileSync(path, `// header\n${BASE}`);
	await expect(visibleEditor(page)).toContainText("// header", { timeout: 10_000 });

	await nativeCommand(page, "undo");
	await expect(visibleEditor(page)).not.toContainText("// mine");
	await expect(visibleEditor(page)).toContainText("// header");
	await nativeCommand(page, "redo");
	await expect(visibleEditor(page)).toContainText("const three = 3; // mine");
});

test("Edit menu undo outside an editor falls back to the browser's own undo", async ({ page }) => {
	await openFile(page, "plain.ts", BASE);
	await page.evaluate(() => {
		const field = document.createElement("textarea");
		field.dataset.testid = "plain-field";
		document.body.append(field);
	});
	const input = page.getByTestId("plain-field");
	await input.focus();
	await page.keyboard.insertText("hello");
	await expect(input).toHaveValue("hello");
	await nativeCommand(page, "undo");
	await expect(input).toHaveValue("");
	await nativeCommand(page, "redo");
	await expect(input).toHaveValue("hello");
	await expect(visibleEditor(page)).toContainText("const one = 1;");
});

test("the banner resolves a conflict by keyboard while the lens stays out of the tab order", async ({
	page,
}) => {
	const path = await openFile(page, "keys.ts", BASE);
	await typeAtLineEnd(page, 2, " // mine");
	writeFileSync(path, "const one = 1;\nconst two = 22;\nconst three = 3;\n");
	await expect(conflictLens(page)).toHaveCount(1, { timeout: 10_000 });
	await expect(conflictLens(page).getByTestId("edit-conflict-mine")).toHaveAttribute(
		"tabindex",
		"-1",
	);

	const theirs = banner(page).getByRole("button", { name: "Theirs" });
	await expect(banner(page).getByRole("group", { name: /First change/ })).toBeVisible();
	await theirs.focus();
	await page.keyboard.press("Enter");
	await expect(conflictLens(page)).toHaveCount(0);
	await expect(banner(page)).toHaveCount(0);
	await nativeCommand(page, "save");
	await expect
		.poll(() => readFileSync(path, "utf8"))
		.toBe("const one = 1;\nconst two = 22;\nconst three = 3;\n");
});
