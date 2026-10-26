import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { PHONE_VIEWPORT, pressPlatformShortcut } from "./fixtures/app";
import {
	banner,
	conflictLens,
	editorHasFocus,
	fileTab,
	openFile,
	typeAtLineEnd,
	unmergeableText,
	visibleEditor,
} from "./fixtures/fileEdit";

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

test("an on-disk change too large to merge waits behind Reload / Keep mine", async ({ page }) => {
	const path = await openFile(page, "conflict.ts", unmergeableText(""));
	await typeAtLineEnd(page, 1, " // mine");

	writeFileSync(path, unmergeableText("theirs"));
	await expect(banner(page)).toHaveAttribute("data-status", "stale", { timeout: 10_000 });
	await expect(visibleEditor(page)).toContainText("// mine");
	await page.getByTestId("file-edit-keep-mine").click();
	await expect(banner(page)).toHaveCount(0);
	await pressPlatformShortcut(page, "s");
	await expect
		.poll(() => readFileSync(path, "utf8"))
		.toBe(unmergeableText("").replace("line 0\n", "line 0 // mine\n"));

	await typeAtLineEnd(page, 1, " again");
	writeFileSync(path, unmergeableText("agent"));
	await expect(banner(page)).toHaveAttribute("data-status", "stale", { timeout: 10_000 });
	await page.getByTestId("file-edit-reload").click();
	await expect(visibleEditor(page)).toContainText("agent line 0");
	await expect(banner(page)).toHaveCount(0);
	await expect(fileTab(page, "conflict.ts").getByTestId("file-dirty-dot")).toHaveCount(0);
});

test("a save against a same-line change on disk writes nothing and pauses on the conflict", async ({
	page,
}) => {
	const path = await openFile(page, "stale.ts", "const base = 1;\n");
	await typeAtLineEnd(page, 1, " // mine");
	writeFileSync(path, "const agent = 2;\n");
	await pressPlatformShortcut(page, "s");

	await expect(banner(page)).toHaveAttribute("data-status", "conflict", { timeout: 10_000 });
	await expect(conflictLens(page)).toHaveCount(1);
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
	await expect.poll(() => draftCount(page)).toBe(0);
});

test("Tab can leave an editable file through Monaco's tab-focus toggle", async ({ page }) => {
	await openFile(page, "focus.ts", "const focus = 1;\n");
	await typeAtLineEnd(page, 1, " // x");
	expect(await editorHasFocus(page)).toBe(true);
	const mac = await page.evaluate(() => navigator.userAgent.includes("Macintosh"));
	await page.keyboard.press(mac ? "Control+Shift+M" : "Control+M");
	await page.keyboard.press("Shift+Tab");
	expect(await editorHasFocus(page)).toBe(false);
	await expect(visibleEditor(page).locator(".view-line").first()).toHaveText(
		"const focus = 1; // x",
	);
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

test("Cmd/Ctrl+/ toggles a line comment in the language's own syntax", async ({ page }) => {
	const path = await openFile(page, "comment.ts", "export const a = 1;\n");
	const firstLine = visibleEditor(page).locator(".view-line").first();
	const mac = await page.evaluate(() => navigator.userAgent.includes("Macintosh"));
	const toggle = mac ? "Meta+/" : "Control+/";
	await firstLine.click();
	await page.keyboard.press(toggle);
	await expect(firstLine).toHaveText("// export const a = 1;");
	await page.keyboard.press(toggle);
	await expect(firstLine).toHaveText("export const a = 1;");
	await page.keyboard.press(toggle);
	await pressPlatformShortcut(page, "s");
	await expect.poll(() => readFileSync(path, "utf8")).toBe("// export const a = 1;\n");
});

test("an unsaved buffer hides review commenting until it is saved", async ({ page }) => {
	await openFile(page, "review.ts", "const reviewed = 1;\nconst other = 2;\n");
	const addIcon = page.locator('[data-testid="review-add-icon"]:visible');
	const selectFirstLine = async () => {
		await visibleEditor(page).locator(".view-line").nth(1).click();
		const box = await visibleEditor(page).locator(".view-line").first().boundingBox();
		if (!box) throw new Error("line 1 has no box");
		await page.mouse.move(box.x + 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 5 });
		await page.mouse.up();
	};
	await selectFirstLine();
	await expect(addIcon).toHaveCount(1);

	await typeAtLineEnd(page, 1, " // moved");
	await selectFirstLine();
	await expect(addIcon).toHaveCount(0);

	await pressPlatformShortcut(page, "s");
	await expect(fileTab(page, "review.ts").getByTestId("file-dirty-dot")).toHaveCount(0);
	await selectFirstLine();
	await expect(addIcon).toHaveCount(1);
});

test("the unsaved dot stays visible in forced colors", async ({ page }) => {
	await openFile(page, "contrast.ts", "const contrast = 1;\n");
	await typeAtLineEnd(page, 1, " // x");
	await page.emulateMedia({ forcedColors: "active" });
	const dot = fileTab(page, "contrast.ts").getByTestId("file-dirty-dot");
	const colors = await dot.evaluate((node) => {
		const probe = document.createElement("span");
		probe.style.backgroundColor = "Canvas";
		document.body.append(probe);
		const canvas = getComputedStyle(probe).backgroundColor;
		probe.remove();
		return { dot: getComputedStyle(node).backgroundColor, canvas };
	});
	expect(colors.dot).not.toBe(colors.canvas);
});

test("removing a workspace deletes the drafts of its files", async ({ page }) => {
	await openFile(page, "removed.ts", "const removed = 1;\n");
	await typeAtLineEnd(page, 1, " // draft");
	await expect.poll(() => draftCount(page)).toBe(1);

	await page.getByTestId("scope-workspace").click();
	await page.getByTestId("scope-workspace-menu").getByTestId("scope-workspace-remove").click();
	await page.getByTestId("confirm-remove").click();
	await expect(fileTab(page, "removed.ts")).toHaveCount(0);
	await expect.poll(() => draftCount(page)).toBe(0);
});

test("a save while disconnected says so at once, and works after the reconnect", async ({
	page,
}) => {
	let firstSocket: WebSocketRoute | undefined;
	let releaseReconnect: () => void = () => {};
	const reconnectAllowed = new Promise<void>((resolve) => {
		releaseReconnect = resolve;
	});
	await page.routeWebSocket(/\/ws(\?|$)/, async (socket) => {
		if (firstSocket) await reconnectAllowed;
		firstSocket ??= socket;
		socket.connectToServer();
	});
	const path = await openFile(page, "offline.ts", "const offline = 1;\n");
	await typeAtLineEnd(page, 1, " // later");

	await firstSocket?.close();
	await expect(page.getByTestId("connection-status")).not.toHaveAttribute(
		"data-status",
		"connected",
	);
	await pressPlatformShortcut(page, "s");
	await expect(banner(page)).toHaveAttribute("data-status", "error");
	await expect(banner(page)).toContainText("Not connected");

	releaseReconnect();
	await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
	await expect(banner(page)).toHaveCount(0);
	await visibleEditor(page).locator(".view-line").first().click();
	await pressPlatformShortcut(page, "s");
	await expect.poll(() => readFileSync(path, "utf8")).toBe("const offline = 1; // later\n");
});

test("Cancel closes the close dialog while its save is still running, and keeps the tab", async ({
	page,
}) => {
	let holdWrites = false;
	await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			if (holdWrites && String(message).includes('"fs.writeFile"')) return;
			server.send(message);
		});
	});
	await openFile(page, "slow.ts", "const slow = 1;\n");
	const tab = fileTab(page, "slow.ts");
	const dialog = page.getByTestId("file-close-guard");
	await typeAtLineEnd(page, 1, " // pending");

	holdWrites = true;
	await tab.hover();
	await tab.getByTestId("editor-tab-close").click();
	await page.getByTestId("file-close-save").click();
	await expect(page.getByTestId("file-close-save")).toHaveText("Saving…");
	await expect(tab.getByTestId("file-dirty-dot")).toHaveAttribute("data-status", "saving");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toBeHidden();
	await expect(tab).toHaveCount(1);
});
