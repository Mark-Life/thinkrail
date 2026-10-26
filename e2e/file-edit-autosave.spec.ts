import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { pressPlatformShortcut } from "./fixtures/app";
import {
	banner,
	conflictLens,
	fileTab,
	openFile,
	pinFileSaveMode,
	typeAtLineEnd,
	visibleEditor,
} from "./fixtures/fileEdit";

const BASE = "const one = 1;\nconst two = 2;\nconst three = 3;\n";

pinFileSaveMode("auto");

function trackWrites(page: Page) {
	const sentAt: number[] = [];
	page.on("websocket", (ws) => {
		ws.on("framesent", (frame) => {
			const payload = typeof frame.payload === "string" ? frame.payload : frame.payload.toString();
			if (payload.includes('"method":"fs.writeFile"')) sentAt.push(Date.now());
		});
	});
	return sentAt;
}

test("typing autosaves after a pause with no Cmd/Ctrl+S, and the save's own echo writes nothing more", async ({
	page,
}) => {
	const writes = trackWrites(page);
	const path = await openFile(page, "auto.ts", BASE);
	const tab = fileTab(page, "auto.ts");

	await typeAtLineEnd(page, 1, " // auto");
	await expect(tab.getByTestId("file-save-pending")).toBeVisible();
	await expect(tab.getByTestId("file-dirty-dot")).toHaveCount(0);
	expect(readFileSync(path, "utf8")).toBe(BASE);

	await expect
		.poll(() => readFileSync(path, "utf8"))
		.toBe("const one = 1; // auto\nconst two = 2;\nconst three = 3;\n");
	await expect(tab.getByTestId("file-save-pending")).toHaveCount(0);
	await page.waitForTimeout(1_500);
	expect(writes).toHaveLength(1);
	await expect(tab.getByTestId("file-dirty-dot")).toHaveCount(0);
	await expect(banner(page)).toHaveCount(0);
});

test("leaving the editor or switching tabs saves at once", async ({ page }) => {
	const writes = trackWrites(page);
	const path = await openFile(page, "flush.ts", BASE);
	const other = join(dirname(path), "other.ts");
	writeFileSync(other, "export {};\n");

	await typeAtLineEnd(page, 1, " // blur");
	const blurredAt = Date.now();
	await page.getByTestId("file-node").filter({ hasText: "flush.ts" }).click();
	await expect.poll(() => writes.length).toBe(1);
	expect(writes[0] - blurredAt).toBeLessThan(700);
	expect(readFileSync(path, "utf8")).toContain("const one = 1; // blur");

	const otherNode = page.getByTestId("file-node").filter({ hasText: "other.ts" });
	await expect(otherNode).toBeVisible();
	await typeAtLineEnd(page, 2, " // switch");
	const switchedAt = Date.now();
	await otherNode.dblclick();
	await expect(fileTab(page, "other.ts")).toBeVisible();
	await expect.poll(() => writes.length).toBe(2);
	expect(writes[1] - switchedAt).toBeLessThan(700);
	expect(readFileSync(path, "utf8")).toBe(
		"const one = 1; // blur\nconst two = 2; // switch\nconst three = 3;\n",
	);
});

test("closing a file autosave is about to write saves it with no prompt", async ({ page }) => {
	const path = await openFile(page, "close.ts", BASE);
	const tab = fileTab(page, "close.ts");
	await typeAtLineEnd(page, 3, " // closing");
	await tab.hover();
	await tab.getByTestId("editor-tab-close").click();
	await expect(tab).toHaveCount(0);
	await expect(page.getByTestId("file-close-guard")).toHaveCount(0);
	await expect
		.poll(() => readFileSync(path, "utf8"))
		.toBe("const one = 1;\nconst two = 2;\nconst three = 3; // closing\n");
});

test("a same-line conflict pauses autosave, only then the close guard asks, and Mine resumes it", async ({
	page,
}) => {
	const path = await openFile(page, "paused.ts", BASE);
	const tab = fileTab(page, "paused.ts");
	await typeAtLineEnd(page, 2, " // mine");
	writeFileSync(path, "const one = 1;\nconst two = 22;\nconst three = 3;\n");

	await expect(conflictLens(page)).toHaveCount(1, { timeout: 10_000 });
	await expect(tab.getByTestId("file-dirty-dot")).toBeVisible();
	await expect(tab.getByTestId("file-save-pending")).toHaveCount(0);
	await page.waitForTimeout(1_500);
	expect(readFileSync(path, "utf8")).toBe("const one = 1;\nconst two = 22;\nconst three = 3;\n");

	await tab.hover();
	await tab.getByTestId("editor-tab-close").click();
	const dialog = page.getByTestId("file-close-guard");
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toBeHidden();

	await conflictLens(page).getByTestId("edit-conflict-mine").click();
	await expect(conflictLens(page)).toHaveCount(0);
	await expect
		.poll(() => readFileSync(path, "utf8"))
		.toBe("const one = 1;\nconst two = 2; // mine\nconst three = 3;\n");
	await expect(tab.getByTestId("file-dirty-dot")).toHaveCount(0);
});

test("turning Autosave off in Settings brings back the dot and Cmd/Ctrl+S", async ({ page }) => {
	const path = await openFile(page, "manual.ts", BASE);
	await page.getByTestId("open-settings").click();
	await page.getByTestId("settings-nav-appearance").click();
	const toggle = page.getByTestId("file-save-mode-auto");
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	const dialog = page.getByTestId("settings-dialog");
	await dialog.getByRole("button", { name: "Close" }).click();
	await expect(dialog).toBeHidden();

	const tab = fileTab(page, "manual.ts");
	await typeAtLineEnd(page, 1, " // manual");
	await expect(tab.getByTestId("file-dirty-dot")).toBeVisible();
	await expect(tab.getByTestId("file-save-pending")).toHaveCount(0);
	await page.getByTestId("file-node").filter({ hasText: "manual.ts" }).click();
	await page.waitForTimeout(1_500);
	expect(readFileSync(path, "utf8")).toBe(BASE);

	await visibleEditor(page).locator(".view-line").first().click();
	await pressPlatformShortcut(page, "s");
	await expect
		.poll(() => readFileSync(path, "utf8"))
		.toBe("const one = 1; // manual\nconst two = 2;\nconst three = 3;\n");
	await expect(tab.getByTestId("file-dirty-dot")).toHaveCount(0);
});
