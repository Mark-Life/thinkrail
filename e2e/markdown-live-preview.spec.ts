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
		await expect(liveLine(page, "Notes").locator(".tr-code-text")).toHaveClass(
			/\btext-text-muted\b/,
		);
		await expect(liveLine(page, "Typed.")).toHaveText("Some bold words and a link. Typed.");
		await liveLine(page, "first").click();
		await expect(liveLine(page, "first")).toHaveText("- first");
		await expect(live(page).locator(".md-bullet")).toHaveCount(1);

		await expect
			.poll(() => readFileSync(path, "utf8"))
			.toBe(NOTES.replace("(other.md).", "(other.md). Typed."));
		await expect(fileTab(page, "notes.md").getByTestId("file-save-pending")).toHaveCount(0);
	});

	test("Enter on an empty item ends the list, so the text after it saves outside the list", async ({
		page,
	}) => {
		const path = await openLive(page, "list-end.md", NOTES);
		await caretAtLineEnd(page, "second");
		await page.keyboard.press("Enter");
		await page.keyboard.press("Enter");
		await page.keyboard.type("after");
		await expect
			.poll(() => readFileSync(path, "utf8"))
			.toBe(NOTES.replace("- second\n", "- second\n\nafter\n"));
		await expect(live(page).locator(".md-bullet")).toHaveCount(2);
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

	test("the caret carries from Source to Preview and across the lock", async ({ page }) => {
		const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1} text`);
		const source = `---\ntitle: t\n---\n\n${lines.join("\n\n")}\n`;
		const path = await openLive(page, "caret.md", source);
		await page.getByTestId("view-toggle-code").click();
		await visibleEditor(page)
			.locator(".view-line")
			.filter({ hasText: /^line\s3\stext$/ })
			.click();
		await page.keyboard.press("End");
		await page.getByTestId("view-toggle-markdown").click();
		await live(page).locator(".cm-content").focus();
		await page.keyboard.type("P");
		await expect.poll(() => readFileSync(path, "utf8")).toContain("line 3 textP\n");
		const lock = page.getByTestId("markdown-lock");
		await lock.click();
		await expect(lock).toHaveAttribute("aria-pressed", "true");
		await lock.click();
		await live(page).locator(".cm-content").focus();
		await page.keyboard.type("Q");
		await expect.poll(() => readFileSync(path, "utf8")).toContain("line 3 textPQ\n");
		await page.getByTestId("view-toggle-code").click();
		await expect(visibleEditor(page)).toContainText("line 3 textPQ");
		await visibleEditor(page).getByRole("textbox", { name: "caret.md" }).focus();
		await page.keyboard.type("S");
		await expect.poll(() => readFileSync(path, "utf8")).toContain("line 3 textPQS\n");
		expect(readFileSync(path, "utf8").startsWith("---\n")).toBe(true);
	});

	test("a task box toggled from the keyboard keeps focus and is named by its item", async ({
		page,
	}) => {
		const source = "- [ ] write **docs**\n- [x] ship\n\nend\n";
		const path = await openLive(page, "tasks.md", source);
		await liveLine(page, "end").click();
		const boxes = live(page).locator("input.md-task");
		await expect(boxes).toHaveCount(2);
		await expect(boxes.nth(0)).toHaveAttribute("aria-label", "write docs");
		await expect(boxes.nth(1)).toHaveAttribute("aria-label", "ship");
		await boxes.nth(0).focus();
		await page.keyboard.press("Space");
		await expect.poll(() => readFileSync(path, "utf8")).toBe(source.replace("[ ]", "[x]"));
		await expect(boxes.nth(0)).toBeChecked();
		await expect(boxes.nth(0)).toBeFocused();
		await page.keyboard.press("Space");
		await expect.poll(() => readFileSync(path, "utf8")).toBe(source);
		await expect(boxes.nth(0)).toBeFocused();
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

test("Cmd/Ctrl+click follows a link; a plain click edits it", async ({ page }) => {
	const path = await openLive(page, "links.md", NOTES);
	writeFileSync(path.replace(/links\.md$/, "other.md"), "# Other target\n");
	const link = live(page).locator(".md-link", { hasText: "link" });
	await expect(link).toHaveAttribute("data-href", "other.md");
	await link.click();
	await expect(liveLine(page, "Some bold")).toContainText("[link](other.md)");
	await expect(fileTab(page, "other.md")).toHaveCount(0);
	await live(page)
		.locator(".md-link")
		.click({ modifiers: ["ControlOrMeta"] });
	await expect(fileTab(page, "other.md")).toBeVisible();
});

test("a link whose title spans lines opens, and Cmd/Ctrl+Enter follows it", async ({ page }) => {
	const source = 'Intro\n\nSee [the target](other.md "line one\nline two") here.\n';
	const path = await openLive(page, "titled.md", source);
	writeFileSync(path.replace(/titled\.md$/, "other.md"), "# Other target\n");
	await expect(live(page).locator(".md-link", { hasText: "the target" })).toBeVisible();
	await expect(live(page).locator(".cm-content")).not.toContainText("(other.md");
	await liveLine(page, "See").getByText("target").click();
	await pressPlatformShortcut(page, "Enter");
	await expect(fileTab(page, "other.md")).toBeVisible();
});

test("Cmd/Ctrl+F finds text below the rendered part of a long document", async ({ page }) => {
	const lines = Array.from({ length: 600 }, (_, index) => `Line ${index + 1} of filler text.`);
	await openLive(page, "long.md", `${lines.join("\n\n")}\n\nThe last word is zebrafind.\n`);
	await liveLine(page, "Line 1 of").click();
	await expect(liveLine(page, "zebrafind")).toHaveCount(0);
	await pressPlatformShortcut(page, "f");
	const find = live(page).getByTestId("markdown-find");
	const field = find.getByRole("searchbox", { name: "Find in file" });
	await expect(field).toBeFocused();
	await field.fill("zebrafind");
	await page.keyboard.press("Enter");
	await expect(liveLine(page, "zebrafind")).toBeInViewport();
	await expect(live(page).locator(".cm-searchMatch-selected")).toHaveText("zebrafind");
	const findRole = await page.evaluate(() => {
		const probe = document.createElement("div");
		probe.style.background = "var(--editor-find-match-bg)";
		document.body.append(probe);
		const color = getComputedStyle(probe).backgroundColor;
		probe.remove();
		return color;
	});
	await expect(live(page).locator(".cm-searchMatch-selected")).toHaveCSS(
		"background-color",
		findRole,
	);
	await page.keyboard.press("Escape");
	await expect(find).toHaveCount(0);
	await expect(live(page).locator(".cm-content")).toBeFocused();
});

test("find shows matches inside a fence, the front matter and a hidden link URL", async ({
	page,
}) => {
	const source =
		"---\ntitle: zebra one\n---\n\nIntro\n\n```\nzebra two\n```\n\nSee [x](https://zebra.example) now.\n";
	await openLive(page, "hidden.md", source);
	await liveLine(page, "Intro").click();
	await pressPlatformShortcut(page, "f");
	await live(page).getByRole("searchbox", { name: "Find in file" }).fill("zebra");
	const selected = live(page).locator(".cm-searchMatch-selected");
	for (const line of ["zebra two", "https://zebra.example", "title: zebra one"]) {
		await page.keyboard.press("Enter");
		await expect(selected).toHaveText("zebra");
		await expect(selected).toBeVisible();
		await expect(liveLine(page, line)).toBeVisible();
	}
});

test("a review card on a fence line keeps its focus and typing while the fence shows source", async ({
	page,
}) => {
	await openLive(page, "card.md", "intro\n\n```\nx\ny\nz\n```\n\nend\n");
	await page.getByTestId("view-toggle-code").click();
	const line = await visibleEditor(page)
		.locator(".view-line")
		.filter({ hasText: /^y$/ })
		.boundingBox();
	if (!line) throw new Error("the y line has no box");
	await page.mouse.move(line.x + 2, line.y + line.height / 2);
	await page.mouse.down();
	await page.mouse.move(line.x + 40, line.y + line.height / 2, { steps: 5 });
	await page.mouse.up();
	await page.locator('[data-testid="review-add-icon"]:visible').click();
	await page.getByTestId("review-composer-input").fill("On y");
	await page.getByTestId("review-composer-save").click();
	await page.getByTestId("view-toggle-markdown").click();

	await live(page).locator(".md-widget-block").click();
	await caretAtLineEnd(page, "y");
	const card = live(page).getByTestId("review-thread-card");
	await expect(card).toHaveCount(1);
	await card.evaluate((node) => {
		node.dataset.probe = "kept";
	});
	const edit = card.getByTestId("review-thread-edit");
	await edit.click();
	await page.keyboard.type(" more");
	await expect(edit).toBeFocused();
	await expect(edit).toHaveValue("On y more");
	await expect(
		live(page).locator('[data-testid="review-thread-card"][data-probe="kept"]'),
	).toHaveCount(1);
});

test("following a heading anchor puts the caret on the heading", async ({ page }) => {
	const filler = Array.from({ length: 80 }, (_, index) => `Filler paragraph ${index + 1}.`);
	const source = `[go](#target)\n\n${filler.join("\n\n")}\n\n## Target\n\nAfter.\n`;
	const path = await openLive(page, "anchor.md", source);
	await live(page).locator(".md-link", { hasText: "go" }).click();
	await pressPlatformShortcut(page, "Enter");
	await expect(
		live(page).locator('.cm-line[role="heading"]', { hasText: "Target" }),
	).toBeInViewport();
	await page.keyboard.press("End");
	await page.keyboard.type(" x");
	await expect.poll(() => readFileSync(path, "utf8")).toContain("## Target x\n");
});

test("a plain click on an anchor in a rendered table moves the caret to its heading", async ({
	page,
}) => {
	const filler = Array.from({ length: 80 }, (_, index) => `Filler paragraph ${index + 1}.`);
	const source = `Intro\n\n| go |\n| - |\n| [jump](#target) |\n\n${filler.join("\n\n")}\n\n## Target\n\nAfter.\n`;
	const path = await openLive(page, "table-anchor.md", source);
	await expect(live(page).locator(".cm-content")).toHaveAttribute("spellcheck", "true");
	await live(page).locator("table a", { hasText: "jump" }).click();
	await expect(
		live(page).locator('.cm-line[role="heading"]', { hasText: "Target" }),
	).toBeInViewport();
	await page.keyboard.press("End");
	await page.keyboard.type(" x");
	await expect.poll(() => readFileSync(path, "utf8")).toContain("## Target x\n");
});

test("a table cell resolves a reference link defined elsewhere in the file", async ({ page }) => {
	const source = "Intro\n\n| a |\n| - |\n| [site][s] |\n\n[s]: https://example.com\n";
	await openLive(page, "refs.md", source);
	await expect(live(page).locator("table a", { hasText: "site" })).toHaveAttribute(
		"href",
		"https://example.com",
	);
});

test("the lock stays clear of the find bar and the text", async ({ page }) => {
	await openLive(
		page,
		"lock.md",
		`# ${"A long heading that wraps across the pane ".repeat(4)}\n\nbody\n`,
	);
	await liveLine(page, "body").click();
	await pressPlatformShortcut(page, "f");
	const lock = page.getByTestId("markdown-lock");
	const close = live(page).getByRole("button", { name: "Close find" });
	await expect(close).toBeVisible();
	const [lockBox, closeBox, lineBox] = await Promise.all([
		lock.boundingBox(),
		close.boundingBox(),
		liveLine(page, "A long heading").boundingBox(),
	]);
	if (!lockBox || !closeBox || !lineBox) throw new Error("missing box");
	expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(lockBox.x);
	expect(lineBox.x + lineBox.width).toBeLessThanOrEqual(lockBox.x);
	await lock.click();
	await expect(lock).toHaveAttribute("aria-pressed", "true");
});

test.describe("manual save", () => {
	pinFileSaveMode("manual");

	test("open then save keeps the file's bytes, CRLF and BOM included", async ({ page }) => {
		const bytes = Buffer.from(`\uFEFF${NOTES.replaceAll("\n", "\r\n")}`, "utf8");
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
			.toBe(`\uFEFF${NOTES.replace("- second", "- second!").replaceAll("\n", "\r\n")}`);
	});

	test("the locked view shows the unsaved buffer", async ({ page }) => {
		await openLive(page, "unsaved.md", NOTES);
		await caretAtLineEnd(page, "first");
		await page.keyboard.type(" XYZ");
		await page.getByTestId("markdown-lock").click();
		const reading = page.locator('[data-testid="markdown-preview"]:visible');
		await expect(live(page)).toHaveCount(0);
		await expect(reading).toContainText("first XYZ");
		await expect(fileTab(page, "unsaved.md").getByTestId("file-dirty-dot")).toBeVisible();
	});

	test("a conflict inside a code fence shows its lens while the caret is outside the fence", async ({
		page,
	}) => {
		const source = "# Code\n\n```sh\none\ntwo\nthree\n```\n\nafter\n";
		const path = await openLive(page, "fence.md", source);
		await expect(live(page).locator(".md-widget-block")).toHaveCount(1);
		await live(page).locator(".md-widget-block").click();
		await caretAtLineEnd(page, "two");
		await page.keyboard.type(" mine");
		await liveLine(page, "after").click();
		await expect(liveLine(page, "two mine")).toHaveCount(0);
		writeFileSync(path, source.replace("two", "two theirs"));
		const lens = live(page).getByTestId("edit-conflict-lens");
		await expect(lens).toBeVisible({ timeout: 10_000 });
		await expect(live(page).locator(".cm-line.edit-conflict-mine")).toHaveText("two mine");
		await expect(live(page).getByTestId("edit-conflict-disk")).toHaveText("two theirs");
	});

	test("a same-line disk change opens the conflict lens in the live preview, and Mine keeps your text", async ({
		page,
	}) => {
		const path = await openLive(page, "conflict.md", NOTES);
		await caretAtLineEnd(page, "first");
		await page.keyboard.type(" mine");
		writeFileSync(path, NOTES.replace("- first", "- first theirs"));
		const lens = live(page).getByTestId("edit-conflict-lens");
		await expect(lens).toBeVisible({ timeout: 10_000 });
		await expect(live(page).getByTestId("edit-conflict-disk")).toHaveText("- first theirs");
		const theirs = live(page).getByTestId("edit-conflict-disk").locator("pre");
		await expect(theirs).toHaveCSS("font-size", "11px");
		await expect(theirs).toHaveCSS("font-weight", "400");
		await expect(live(page).locator(".cm-line.edit-conflict-mine")).toHaveText(/first mine$/);
		await lens.getByTestId("edit-conflict-mine").click();
		await expect(lens).toHaveCount(0);
		await pressPlatformShortcut(page, "s");
		await expect
			.poll(() => readFileSync(path, "utf8"))
			.toBe(NOTES.replace("- first", "- first mine"));
	});
});

test("an outside write marks its lines in the live preview", async ({ page }) => {
	const path = await openLive(page, "outside.md", NOTES);
	await caretAtLineEnd(page, "first");
	await page.keyboard.type(" mine");
	const saved = NOTES.replace("- first", "- first mine");
	await expect.poll(() => readFileSync(path, "utf8")).toBe(saved);
	await liveLine(page, "Notes").click();
	await page.waitForTimeout(1_500);
	await expect(live(page).locator(".presence-bar")).toHaveCount(0);
	writeFileSync(path, saved.replace("- second", "- second from outside"));
	const bar = live(page).locator(".cm-line.presence-bar.presence-tone-external");
	await expect(bar).toHaveText(/second from outside/, { timeout: 10_000 });
	await expect(bar).toHaveAttribute("title", "Changed by External (inferred from timing)");
	const [barLeft, scrollerLeft] = await bar.evaluate((line) => {
		const scroller = line.closest(".cm-scroller");
		if (!scroller) throw new Error("no scroller");
		const left = Number.parseFloat(getComputedStyle(line, "::after").left);
		return [line.getBoundingClientRect().left + left, scroller.getBoundingClientRect().left];
	});
	expect(barLeft).toBeGreaterThanOrEqual(scrollerLeft);
	await expect
		.poll(
			() =>
				live(page)
					.locator(".cm-content")
					.evaluate((content) => {
						const line = content.querySelector(".cm-line.presence-wash-3");
						if (!line) return null;
						const wash = getComputedStyle(line, "::before");
						return [getComputedStyle(line).opacity, wash.opacity, wash.position];
					}),
			{ timeout: 10_000, intervals: [50] },
		)
		.toEqual(["1", "0.12", "absolute"]);
	const flag = live(page).locator('[data-presence="flag"]');
	await expect(flag).toHaveText("External");
	await expect(flag.locator(".presence-flag-icon svg")).toHaveCount(1);
	expect(
		await flag
			.locator(".presence-flag-body")
			.evaluate((body) => getComputedStyle(body).borderTopWidth),
	).toBe("0px");
});
