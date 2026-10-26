import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { FileSaveMode } from "@thinkrail/contracts";
import { createWorkspaceViaDialog, openFixtureProject, revealWorkbenchTool } from "./app";
import { E2eWire } from "./wire";

export async function setFileSaveMode(baseURL: string | undefined, fileSaveMode: FileSaveMode) {
	if (!baseURL) throw new Error("The file save mode fixture requires the isolated host URL");
	const wire = await E2eWire.connect(Number(new URL(baseURL).port));
	try {
		await wire.request("settings.update", { config: { fileSaveMode } });
	} finally {
		wire.close();
	}
}

export function pinFileSaveMode(mode: FileSaveMode) {
	test.beforeEach(({ baseURL }) => setFileSaveMode(baseURL, mode));
	test.afterEach(({ baseURL }) => setFileSaveMode(baseURL, "auto"));
}

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

export function unmergeableText(tag: string) {
	return Array.from({ length: 2500 }, (_, index) =>
		index % 2 === 0 && tag ? `${tag} line ${index}\n` : `line ${index}\n`,
	).join("");
}

export function conflictLens(page: Page) {
	return page.locator('[data-testid="edit-conflict-lens"]:visible');
}

export async function editorShortcut(page: Page, key: string) {
	const mac = await page.evaluate(() => navigator.userAgent.includes("Macintosh"));
	await page.keyboard.press(`${mac ? "Meta" : "Control"}+${key}`);
}

export async function commentOnFirstLine(page: Page, body: string) {
	await visibleEditor(page).locator(".view-line").nth(1).click();
	const box = await visibleEditor(page).locator(".view-line").first().boundingBox();
	if (!box) throw new Error("line 1 has no box");
	await page.mouse.move(box.x + 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 5 });
	await page.mouse.up();
	await page.locator('[data-testid="review-add-icon"]:visible').click();
	await page.getByTestId("review-composer-input").fill(body);
	await page.getByTestId("review-composer-save").click();
	await expect(page.getByTestId("review-thread-card")).toHaveCount(1);
}
