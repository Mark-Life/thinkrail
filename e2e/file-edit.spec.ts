import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	createWorkspaceViaDialog,
	openFixtureProject,
	PHONE_VIEWPORT,
	pressPlatformShortcut,
	revealWorkbenchTool,
} from "./fixtures/app";

function visibleEditor(page: Page) {
	return page.locator('[data-testid="editor-pane"]:visible .monaco-editor');
}

function fileTab(page: Page, name: string) {
	return page.getByTestId("editor-tab").filter({ hasText: name });
}

function banner(page: Page) {
	return page.getByTestId("file-edit-banner");
}

async function openFile(page: Page, name: string, text: string) {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	const path = join(workspace.worktreePath, name);
	writeFileSync(path, text);
	await revealWorkbenchTool(page, "files");
	await page.getByTestId("file-node").filter({ hasText: name }).dblclick();
	await expect(visibleEditor(page)).toBeVisible();
	await expect(page.locator("[data-file-buffer]")).toHaveCount(1);
	return path;
}

function draftCount(page: Page) {
	return page.evaluate(async () => {
		const databases = await indexedDB.databases();
		if (!databases.some((database) => database.name === "thinkrail-drafts")) return 0;
		return new Promise<number>((resolve, reject) => {
			const open = indexedDB.open("thinkrail-drafts");
			open.onerror = () => reject(open.error);
			open.onsuccess = () => {
				const db = open.result;
				const count = db.transaction("drafts").objectStore("drafts").count();
				count.onsuccess = () => {
					db.close();
					resolve(count.result);
				};
			};
		});
	});
}

async function typeAtLineEnd(page: Page, line: number, text: string) {
	await visibleEditor(page)
		.locator(".view-line")
		.nth(line - 1)
		.click();
	await page.keyboard.press("End");
	await page.keyboard.type(text);
}

test("typing marks the tab unsaved and Cmd/Ctrl+S writes it, keeping the file's line endings", async ({
	page,
}) => {
	const path = await openFile(page, "edit.ts", "export const a = 1;\r\nexport const b = 2;\r\n");
	await expect(fileTab(page, "edit.ts").getByTestId("file-dirty-dot")).toHaveCount(0);

	await typeAtLineEnd(page, 1, " // edited");
	await expect(fileTab(page, "edit.ts").getByTestId("file-dirty-dot")).toBeVisible();
	expect(readFileSync(path, "utf8")).toBe("export const a = 1;\r\nexport const b = 2;\r\n");

	await pressPlatformShortcut(page, "s");
	await expect(fileTab(page, "edit.ts").getByTestId("file-dirty-dot")).toHaveCount(0);
	await expect
		.poll(() => readFileSync(path, "utf8"))
		.toBe("export const a = 1; // edited\r\nexport const b = 2;\r\n");
	await expect(banner(page)).toHaveCount(0);
});

test("closing an unsaved tab asks: Cancel keeps it, Don't save drops it, Save writes it", async ({
	page,
}) => {
	const path = await openFile(page, "guard.ts", "const value = 1;\n");
	const tab = fileTab(page, "guard.ts");
	const dialog = page.getByTestId("file-close-guard");

	await typeAtLineEnd(page, 1, " // draft");
	await tab.hover();
	await tab.getByTestId("editor-tab-close").click();
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toBeHidden();
	await expect(tab).toHaveCount(1);

	await tab.hover();
	await tab.getByTestId("editor-tab-close").click();
	await page.getByTestId("file-close-discard").click();
	await expect(tab).toHaveCount(0);
	expect(readFileSync(path, "utf8")).toBe("const value = 1;\n");

	await page.getByTestId("file-node").filter({ hasText: "guard.ts" }).dblclick();
	await expect(visibleEditor(page)).toContainText("const value = 1;");
	await expect(visibleEditor(page)).not.toContainText("draft");
	await typeAtLineEnd(page, 1, " // kept");
	await tab.hover();
	await tab.getByTestId("editor-tab-close").click();
	await page.getByTestId("file-close-save").click();
	await expect(tab).toHaveCount(0);
	expect(readFileSync(path, "utf8")).toBe("const value = 1; // kept\n");
});

test("a clean buffer follows an on-disk change in place and keeps the cursor", async ({ page }) => {
	const path = await openFile(
		page,
		"live.ts",
		"const first = 1;\nconst second = 2;\nconst third = 3;\n",
	);
	await visibleEditor(page).evaluate((node) => node.setAttribute("data-e2e-mount", "first"));
	await visibleEditor(page).locator(".view-line").first().click();
	await page.keyboard.press("End");

	writeFileSync(path, "const first = 1;\nconst second = 2;\nconst third = 33;\n");
	await expect(visibleEditor(page)).toContainText("const third = 33;", { timeout: 10_000 });
	await expect(visibleEditor(page)).toHaveAttribute("data-e2e-mount", "first");
	await expect(fileTab(page, "live.ts").getByTestId("file-dirty-dot")).toHaveCount(0);

	await page.keyboard.type("!");
	await pressPlatformShortcut(page, "s");
	await expect
		.poll(() => readFileSync(path, "utf8"))
		.toBe("const first = 1;!\nconst second = 2;\nconst third = 33;\n");
});

test("an on-disk change to an unsaved buffer waits behind Reload / Keep mine", async ({ page }) => {
	const path = await openFile(page, "conflict.ts", "const mine = 1;\n");
	await typeAtLineEnd(page, 1, " // mine");

	writeFileSync(path, "const theirs = 2;\n");
	await expect(banner(page)).toHaveAttribute("data-status", "stale", { timeout: 10_000 });
	await expect(visibleEditor(page)).toContainText("// mine");
	await page.getByTestId("file-edit-keep-mine").click();
	await expect(banner(page)).toHaveCount(0);
	await pressPlatformShortcut(page, "s");
	await expect.poll(() => readFileSync(path, "utf8")).toBe("const mine = 1; // mine\n");

	await typeAtLineEnd(page, 1, " again");
	writeFileSync(path, "const agent = 3;\n");
	await expect(banner(page)).toHaveAttribute("data-status", "stale", { timeout: 10_000 });
	await page.getByTestId("file-edit-reload").click();
	await expect(visibleEditor(page)).toContainText("const agent = 3;");
	await expect(banner(page)).toHaveCount(0);
	await expect(fileTab(page, "conflict.ts").getByTestId("file-dirty-dot")).toHaveCount(0);
});

test("a save against a file that changed on disk writes nothing and shows the conflict", async ({
	page,
}) => {
	const path = await openFile(page, "stale.ts", "const base = 1;\n");
	await typeAtLineEnd(page, 1, " // mine");
	writeFileSync(path, "const agent = 2;\n");
	await pressPlatformShortcut(page, "s");

	await expect(banner(page)).toHaveAttribute("data-status", "stale", { timeout: 10_000 });
	expect(readFileSync(path, "utf8")).toBe("const agent = 2;\n");
	await expect(fileTab(page, "stale.ts").getByTestId("file-dirty-dot")).toBeVisible();
});

test("a file deleted on disk says so, and Save creates it again", async ({ page }) => {
	const path = await openFile(page, "gone.ts", "const kept = true;\n");
	rmSync(path);
	await expect(banner(page)).toHaveAttribute("data-status", "deleted", { timeout: 10_000 });
	await expect(visibleEditor(page)).toContainText("const kept = true;");

	await pressPlatformShortcut(page, "s");
	await expect.poll(() => existsSync(path)).toBe(true);
	expect(readFileSync(path, "utf8")).toBe("const kept = true;\n");
	await expect(banner(page)).toHaveCount(0);
});

test("unsaved edits come back after a reload", async ({ page }) => {
	const path = await openFile(page, "draft.ts", "const draft = 1;\n");
	await typeAtLineEnd(page, 1, " // survives");
	await expect.poll(() => draftCount(page)).toBe(1);

	await page.reload();
	await expect(visibleEditor(page)).toContainText("// survives", { timeout: 15_000 });
	await expect(fileTab(page, "draft.ts").getByTestId("file-dirty-dot")).toBeVisible();
	expect(readFileSync(path, "utf8")).toBe("const draft = 1;\n");

	await visibleEditor(page).locator(".view-line").first().click();
	await pressPlatformShortcut(page, "s");
	await expect.poll(() => readFileSync(path, "utf8")).toBe("const draft = 1; // survives\n");
});

test("a phone-class viewport stays read-only", async ({ page }) => {
	const path = await openFile(page, "phone.ts", "const phone = 1;\n");
	await page.setViewportSize(PHONE_VIEWPORT);
	await expect(page.locator('[data-testid="editor-pane"]:visible .monaco-editor')).toHaveCount(0);
	await expect(page.locator("[data-file-buffer]")).toHaveCount(0);
	await expect(page.getByTestId("editor-pane").filter({ visible: true })).toContainText(
		"const phone = 1;",
	);
	await page.keyboard.type("typed");
	await pressPlatformShortcut(page, "s");
	expect(readFileSync(path, "utf8")).toBe("const phone = 1;\n");
});
