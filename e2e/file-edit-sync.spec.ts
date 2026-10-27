import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { pressPlatformShortcut, revealWorkbenchTool } from "./fixtures/app";
import {
	banner,
	editorHasFocus,
	fileTab,
	openFile,
	openWorkspaceWithFile,
	typeAtLineEnd,
	unmergeableText,
	visibleEditor,
} from "./fixtures/fileEdit";

function parseFrame(message: string | Buffer): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(String(message));
		return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

async function commentOnFirstLine(page: Page, body: string) {
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

test("a file that changes on disk while it opens shows the new text and saves without a conflict", async ({
	page,
}) => {
	const name = "racing.ts";
	let holdRead = false;
	let heldId: unknown;
	let releaseRead: (() => void) | null = null;
	let workspaceId: string | undefined;
	let written = false;
	let fsChangeSeen = false;
	const isWriteChange = (frame: Record<string, unknown> | null) => {
		if (!written || frame?.channel !== "workspace.fsChanged") return false;
		const data = frame.data as { workspaceId?: string; paths?: string[] } | undefined;
		return data?.workspaceId === workspaceId && data?.paths?.includes(name) === true;
	};
	await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			const frame = parseFrame(message);
			const params = frame?.params as { path?: string; workspaceId?: string } | undefined;
			if (holdRead && frame?.method === "fs.readFile" && params?.path === name) {
				holdRead = false;
				heldId = frame.id;
				workspaceId = params.workspaceId;
			}
			server.send(message);
		});
		server.onMessage((message) => {
			const frame = parseFrame(message);
			if (heldId !== undefined && frame?.id === heldId) {
				heldId = undefined;
				releaseRead = () => socket.send(message);
				return;
			}
			if (isWriteChange(frame)) {
				if (fsChangeSeen) return;
				fsChangeSeen = true;
			}
			socket.send(message);
		});
	});
	const path = await openWorkspaceWithFile(page, name, "const old = 1;\n");

	holdRead = true;
	await page.getByTestId("file-node").filter({ hasText: name }).dblclick();
	await expect.poll(() => releaseRead !== null).toBe(true);
	written = true;
	writeFileSync(path, "const agent = 2;\n");
	await expect.poll(() => fsChangeSeen, { timeout: 10_000 }).toBe(true);
	releaseRead?.();

	await expect(visibleEditor(page)).toBeVisible();
	await expect(page.locator("[data-file-buffer]")).toHaveCount(1);
	await expect(visibleEditor(page)).toContainText("const agent = 2;");
	await typeAtLineEnd(page, 1, " // mine");
	await pressPlatformShortcut(page, "s");
	await expect.poll(() => readFileSync(path, "utf8")).toBe("const agent = 2; // mine\n");
	await expect(banner(page)).toHaveCount(0);
});

test("an unsaved buffer hides review threads in Preview too", async ({ page }) => {
	const path = await openWorkspaceWithFile(page, "notes.md", "# Notes\n\nFirst paragraph.\n");
	await page.getByTestId("file-node").filter({ hasText: "notes.md" }).dblclick();
	await page.getByTestId("view-toggle-code").click();
	await expect(page.locator("[data-file-buffer]")).toHaveCount(1);
	await commentOnFirstLine(page, "Rename the title");

	await page.getByTestId("view-toggle-markdown").click();
	await expect(page.getByTestId("review-thread-card")).toHaveCount(1);
	await page.getByTestId("view-toggle-code").click();
	await typeAtLineEnd(page, 1, "\n\nNew line");
	await page.getByTestId("view-toggle-markdown").click();
	await expect(page.getByTestId("editor-pane").filter({ visible: true })).toContainText("New line");
	await expect(page.getByTestId("review-thread-card")).toHaveCount(0);

	await pressPlatformShortcut(page, "s");
	await expect.poll(() => readFileSync(path, "utf8")).toContain("New line");
	await expect(page.getByTestId("review-thread-card")).toHaveCount(1);
});

function topVisibleLine(page: Page) {
	return visibleEditor(page).evaluate((node) => {
		const host = node.getBoundingClientRect();
		const numbers = [...node.querySelectorAll(".line-numbers")]
			.filter((line) => {
				const box = line.getBoundingClientRect();
				return box.bottom > host.top && box.top < host.bottom;
			})
			.map((line) => Number(line.textContent));
		return Math.min(...numbers);
	});
}

test("a Review panel jump on an unsaved file is dropped, not replayed after Save", async ({
	page,
}) => {
	const text = Array.from({ length: 400 }, (_, index) => `const row${index + 1} = 1;\n`).join("");
	await openFile(page, "jump.ts", text);
	await commentOnFirstLine(page, "Look here");

	await visibleEditor(page).locator(".view-line").nth(2).click();
	for (let press = 0; press < 20; press += 1) await page.keyboard.press("PageDown");
	await page.keyboard.press("End");
	await page.keyboard.type(" // dirty");
	await expect(fileTab(page, "jump.ts").getByTestId("file-dirty-dot")).toBeVisible();
	await page.waitForTimeout(400);
	const scrolled = await topVisibleLine(page);
	expect(scrolled).toBeGreaterThan(30);

	await revealWorkbenchTool(page, "review");
	const section = page
		.getByTestId("review-file-section")
		.filter({ has: page.getByTestId("review-file-row").filter({ hasText: "jump.ts" }) });
	if ((await section.getAttribute("data-expanded")) !== "true") {
		await section.getByTestId("review-file-row").click();
	}
	await section.getByTestId("review-comment-open").first().click();
	await page.waitForTimeout(500);
	expect(await topVisibleLine(page)).toBe(scrolled);

	await visibleEditor(page).locator(".view-line").nth(3).click();
	await pressPlatformShortcut(page, "s");
	await expect(fileTab(page, "jump.ts").getByTestId("file-dirty-dot")).toHaveCount(0);
	await page.waitForTimeout(800);
	expect(await topVisibleLine(page)).toBeGreaterThan(30);
});

test("Save from the close dialog of a background tab that fails selects that tab to show why", async ({
	page,
}) => {
	const path = await openFile(page, "aa.ts", "const a = 1;\n");
	await typeAtLineEnd(page, 1, " // mine");
	writeFileSync(join(dirname(path), "bb.ts"), "const b = 1;\n");
	await page.getByTestId("file-node").filter({ hasText: "bb.ts" }).dblclick();
	await expect(visibleEditor(page)).toContainText("const b = 1;");
	writeFileSync(path, "const a = 2; // theirs\n");

	const tab = fileTab(page, "aa.ts");
	await tab.hover();
	await tab.getByTestId("editor-tab-close").click();
	await page.getByTestId("file-close-save").click();
	await expect(page.getByTestId("file-close-guard")).toBeHidden();
	await expect(tab).toHaveCount(1);
	await expect(tab).toHaveAttribute("data-active", "true");
	await expect(banner(page)).toHaveAttribute("data-status", "conflict");
	expect(readFileSync(path, "utf8")).toBe("const a = 2; // theirs\n");
});

test("Reload and Keep mine put keyboard focus back in the editor", async ({ page }) => {
	const path = await openFile(page, "focus.ts", unmergeableText(""));
	for (const [action, theirs] of [
		["file-edit-keep-mine", unmergeableText("theirs")],
		["file-edit-reload", unmergeableText("again")],
	] as const) {
		await typeAtLineEnd(page, 1, " // mine");
		writeFileSync(path, theirs);
		await expect(banner(page)).toHaveAttribute("data-status", "stale", { timeout: 10_000 });
		await page.getByTestId(action).focus();
		await page.keyboard.press("Enter");
		await expect(banner(page)).toHaveCount(0);
		expect(await editorHasFocus(page)).toBe(true);
	}
	await page.keyboard.type("// typed ");
	await expect(visibleEditor(page)).toContainText("// typed");
});
