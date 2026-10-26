import { readFileSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { pressPlatformShortcut } from "./fixtures/app";
import {
	fileTab,
	openWorkspaceWithFile,
	pinFileSaveMode,
	visibleEditor,
} from "./fixtures/fileEdit";

const NOTES = "# Notes\n\nSome **bold** words and a [link](other.md).\n\n- first\n- second\n";

function live(page: Page) {
	return page.locator('[data-testid="markdown-preview"][data-mode="live"]:visible');
}

function liveLine(page: Page, text: string) {
	return live(page).locator(".cm-line").filter({ hasText: text });
}

async function openLive(page: Page, name: string, text: string | Buffer) {
	const path = await openWorkspaceWithFile(page, name, "");
	writeFileSync(path, text);
	await page.getByTestId("file-node").filter({ hasText: name }).dblclick();
	await expect(live(page).locator(".cm-content")).toBeVisible();
	await expect(page.locator("[data-file-buffer]")).toHaveCount(1);
	return path;
}

async function caretAtLineEnd(page: Page, text: string) {
	await liveLine(page, text).click();
	await page.keyboard.press("End");
}

test.describe("autosave", () => {
	pinFileSaveMode("auto");

	test("typing in Preview shows markers only at the caret and autosaves the source", async ({
		page,
	}) => {
		const path = await openLive(page, "notes.md", NOTES);
		const content = live(page).locator(".cm-content");
		await expect(content).toContainText("Notes");
		await expect(content).not.toContainText("**");
		await expect(content).not.toContainText("# Notes");
		await expect(content).not.toContainText("(other.md)");
		await expect(live(page).locator(".md-bullet")).toHaveCount(2);

		await caretAtLineEnd(page, "Some bold words");
		await page.keyboard.type(" Typed.");
		await expect(liveLine(page, "Typed.")).toHaveText("Some bold words and a link. Typed.");
		await expect(fileTab(page, "notes.md").getByTestId("file-save-pending")).toBeVisible();

		await liveLine(page, "bold").getByText("bold", { exact: true }).click();
		await expect(liveLine(page, "Typed.")).toHaveText("Some **bold** words and a link. Typed.");
		await liveLine(page, "Notes").click();
		await expect(liveLine(page, "Notes")).toHaveText("# Notes");
		await expect(liveLine(page, "Typed.")).toHaveText("Some bold words and a link. Typed.");
		await liveLine(page, "first").click();
		await expect(liveLine(page, "first")).toHaveText("- first");
		await expect(live(page).locator(".md-bullet")).toHaveCount(1);

		await expect
			.poll(() => readFileSync(path, "utf8"))
			.toBe(NOTES.replace("(other.md).", "(other.md). Typed."));
		await expect(fileTab(page, "notes.md").getByTestId("file-save-pending")).toHaveCount(0);
	});

	test("a disk change on another line merges into the live preview while you type", async ({
		page,
	}) => {
		const path = await openLive(page, "merge.md", NOTES);
		await caretAtLineEnd(page, "second");
		await page.keyboard.type(" mine");
		writeFileSync(path, NOTES.replace("# Notes", "# Agent notes"));
		await expect(liveLine(page, "Agent notes")).toBeVisible({ timeout: 10_000 });
		await expect(liveLine(page, "second mine")).toBeVisible();
		await page.keyboard.type("!");
		await expect
			.poll(() => readFileSync(path, "utf8"))
			.toBe(NOTES.replace("# Notes", "# Agent notes").replace("- second", "- second mine!"));
	});

	test("Preview and Source are two views of one buffer, with one undo history", async ({
		page,
	}) => {
		const path = await openLive(page, "sync.md", NOTES);
		await caretAtLineEnd(page, "first");
		await page.keyboard.type(" from preview");
		await page.getByTestId("view-toggle-code").click();
		await expect(visibleEditor(page)).toContainText("- first from preview");

		await visibleEditor(page).locator(".view-line").filter({ hasText: "second" }).click();
		await page.keyboard.press("End");
		await page.keyboard.type(" from source");
		await page.getByTestId("view-toggle-markdown").click();
		await expect(liveLine(page, "second from source")).toBeVisible();

		await live(page).locator(".cm-content").focus();
		await pressPlatformShortcut(page, "z");
		await expect(liveLine(page, "second")).toHaveText(/^(?:- )?second$/);
		await expect(liveLine(page, "first from preview")).toBeVisible();
		await expect
			.poll(() => readFileSync(path, "utf8"))
			.toBe(NOTES.replace("- first", "- first from preview"));
	});

	test("the lock keeps a review pass from typing into the file", async ({ page }) => {
		const path = await openLive(page, "locked.md", NOTES);
		const lock = page.getByTestId("markdown-lock");
		await expect(lock).toHaveAttribute("aria-pressed", "false");
		await lock.click();
		await expect(lock).toHaveAttribute("aria-pressed", "true");
		await expect(live(page)).toHaveCount(0);
		const reading = page.locator('[data-testid="markdown-preview"]:visible');
		await expect(reading.getByRole("heading", { name: "Notes" })).toBeVisible();
		await expect(reading.locator("[contenteditable='true']")).toHaveCount(0);
		await reading.getByText("first").click();
		await page.keyboard.type("nope");
		await page.waitForTimeout(1_500);
		expect(readFileSync(path, "utf8")).toBe(NOTES);

		await lock.click();
		await expect(lock).toHaveAttribute("aria-pressed", "false");
		await caretAtLineEnd(page, "first");
		await page.keyboard.type(" yes");
		await expect
			.poll(() => readFileSync(path, "utf8"))
			.toBe(NOTES.replace("- first", "- first yes"));
	});
});

test.describe("manual save", () => {
	pinFileSaveMode("manual");

	test("open then save keeps the file's bytes, CRLF and BOM included", async ({ page }) => {
		const bytes = Buffer.from(`﻿${NOTES.replaceAll("\n", "\r\n")}`, "utf8");
		const path = await openLive(page, "bytes.md", bytes);
		await caretAtLineEnd(page, "second");
		await page.keyboard.type("x");
		await page.keyboard.press("Backspace");
		await pressPlatformShortcut(page, "s");
		await page.waitForTimeout(500);
		expect(readFileSync(path).equals(bytes)).toBe(true);

		await page.keyboard.type("!");
		await expect(fileTab(page, "bytes.md").getByTestId("file-dirty-dot")).toBeVisible();
		await pressPlatformShortcut(page, "s");
		await expect
			.poll(() => readFileSync(path).toString("utf8"))
			.toBe(`﻿${NOTES.replace("- second", "- second!").replaceAll("\n", "\r\n")}`);
	});
});
