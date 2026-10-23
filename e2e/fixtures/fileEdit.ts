import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { createWorkspaceViaDialog, openFixtureProject, revealWorkbenchTool } from "./app";

export function visibleEditor(page: Page) {
	return page.locator('[data-testid="editor-pane"]:visible .monaco-editor');
}

export function fileTab(page: Page, name: string) {
	return page.getByTestId("editor-tab").filter({ hasText: name });
}

export function banner(page: Page) {
	return page.getByTestId("file-edit-banner");
}

export async function openWorkspaceWithFile(page: Page, name: string, text: string) {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	const path = join(workspace.worktreePath, name);
	writeFileSync(path, text);
	await revealWorkbenchTool(page, "files");
	return path;
}

export async function openFile(page: Page, name: string, text: string) {
	const path = await openWorkspaceWithFile(page, name, text);
	await page.getByTestId("file-node").filter({ hasText: name }).dblclick();
	await expect(visibleEditor(page)).toBeVisible();
	await expect(page.locator("[data-file-buffer]")).toHaveCount(1);
	return path;
}

export async function typeAtLineEnd(page: Page, line: number, text: string) {
	await visibleEditor(page)
		.locator(".view-line")
		.nth(line - 1)
		.click();
	await page.keyboard.press("End");
	await page.keyboard.type(text);
}

export function editorHasFocus(page: Page) {
	return page.evaluate(() => document.activeElement?.closest(".monaco-editor") !== null);
}
