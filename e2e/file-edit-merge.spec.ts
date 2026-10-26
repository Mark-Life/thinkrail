import { readFileSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { pressPlatformShortcut } from "./fixtures/app";
import {
	banner,
	conflictLens,
	editorHasFocus,
	editorShortcut,
	fileTab,
	openFile,
	typeAtLineEnd,
	visibleEditor,
} from "./fixtures/fileEdit";

const BASE = "const one = 1;\nconst two = 2;\nconst three = 3;\n";

function editorText(page: Page) {
	return visibleEditor(page).evaluate((node) =>
		[...node.querySelectorAll(".view-line")]
			.map((line) => ({
				top: Number.parseFloat((line as HTMLElement).style.top),
				text: (line.textContent ?? "").replace(/ /g, " "),
			}))
			.sort((a, b) => a.top - b.top)
			.map((line) => line.text)
			.join("\n"),
	);
}

test("an on-disk change to another line merges into unsaved edits, and Save writes both", async ({
	page,
}) => {
	const path = await openFile(page, "merge.ts", BASE);
	await typeAtLineEnd(page, 1, " // mine");

	writeFileSync(path, "const one = 1;\nconst two = 2;\nconst three = 33;\n");
	await expect(visibleEditor(page)).toContainText("const three = 33;", { timeout: 10_000 });
	await expect(visibleEditor(page)).toContainText("const one = 1; // mine");
	await expect(banner(page)).toHaveCount(0);
	await expect(fileTab(page, "merge.ts").getByTestId("file-dirty-dot")).toBeVisible();

	await page.keyboard.type("!");
	await pressPlatformShortcut(page, "s");
	await expect
		.poll(() => readFileSync(path, "utf8"))
		.toBe("const one = 1; // mine!\nconst two = 2;\nconst three = 33;\n");
	await expect(fileTab(page, "merge.ts").getByTestId("file-dirty-dot")).toHaveCount(0);
});

test("Cmd/Ctrl+Z undoes only your edit and keeps the merged disk change", async ({ page }) => {
	const path = await openFile(page, "undo.ts", BASE);
	await typeAtLineEnd(page, 3, " // mine");

	writeFileSync(path, `// header\n${BASE}`);
	await expect(visibleEditor(page)).toContainText("// header", { timeout: 10_000 });
	await expect(visibleEditor(page)).toContainText("const three = 3; // mine");

	await editorShortcut(page, "z");
	await expect.poll(() => editorText(page)).toBe(`// header\n${BASE}`);
	await expect(fileTab(page, "undo.ts").getByTestId("file-dirty-dot")).toHaveCount(0);

	await editorShortcut(page, "Shift+z");
	await expect(visibleEditor(page)).toContainText("const three = 3; // mine");
	await pressPlatformShortcut(page, "s");
	await expect
		.poll(() => readFileSync(path, "utf8"))
		.toBe("// header\nconst one = 1;\nconst two = 2;\nconst three = 3; // mine\n");
});

test("a change to the same line pauses the file until Mine, Theirs or Both, which undo can reopen", async ({
	page,
}) => {
	const path = await openFile(page, "clash.ts", BASE);
	await typeAtLineEnd(page, 2, " // mine");

	writeFileSync(path, "const one = 1;\nconst two = 22;\nconst three = 3;\n");
	await expect(conflictLens(page)).toHaveCount(1, { timeout: 10_000 });
	await expect(banner(page)).toHaveAttribute("data-status", "conflict");
	await expect(page.locator('[data-testid="edit-conflict-disk"]:visible')).toContainText(
		"const two = 22;",
	);

	await pressPlatformShortcut(page, "s");
	await page.waitForTimeout(300);
	expect(readFileSync(path, "utf8")).toBe("const one = 1;\nconst two = 22;\nconst three = 3;\n");

	await conflictLens(page).getByTestId("edit-conflict-both").click();
	await expect(conflictLens(page)).toHaveCount(0);
	expect(await editorHasFocus(page)).toBe(true);
	await expect
		.poll(() => editorText(page))
		.toBe("const one = 1;\nconst two = 2; // mine\nconst two = 22;\nconst three = 3;\n");

	await editorShortcut(page, "z");
	await expect(conflictLens(page)).toHaveCount(1);
	await expect
		.poll(() => editorText(page))
		.toBe(`const one = 1;\nconst two = 2; // mine\nconst three = 3;\n`);

	await conflictLens(page).getByTestId("edit-conflict-theirs").click();
	await expect(banner(page)).toHaveCount(0);
	await pressPlatformShortcut(page, "s");
	await expect
		.poll(() => readFileSync(path, "utf8"))
		.toBe("const one = 1;\nconst two = 22;\nconst three = 3;\n");
	await expect(fileTab(page, "clash.ts").getByTestId("file-dirty-dot")).toHaveCount(0);
});

test("a save that meets an unseen disk change on another line merges it and retries once", async ({
	page,
}) => {
	let hideFsChanges = false;
	const writes: unknown[] = [];
	await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			if (String(message).includes('"method":"fs.writeFile"')) writes.push(message);
			server.send(message);
		});
		server.onMessage((message) => {
			if (hideFsChanges && String(message).includes('"channel":"workspace.fsChanged"')) return;
			socket.send(message);
		});
	});
	const path = await openFile(page, "race.ts", BASE);
	await typeAtLineEnd(page, 1, " // mine");
	hideFsChanges = true;
	writeFileSync(path, "const one = 1;\nconst two = 2;\nconst three = 33;\n");
	await page.waitForTimeout(1500);
	await expect(visibleEditor(page)).not.toContainText("const three = 33;");
	await pressPlatformShortcut(page, "s");

	await expect
		.poll(() => readFileSync(path, "utf8"), { timeout: 10_000 })
		.toBe("const one = 1; // mine\nconst two = 2;\nconst three = 33;\n");
	expect(writes).toHaveLength(2);
	await expect(visibleEditor(page)).toContainText("const three = 33;");
	await expect(fileTab(page, "race.ts").getByTestId("file-dirty-dot")).toHaveCount(0);
	await expect(banner(page)).toHaveCount(0);
});
