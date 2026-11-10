import { compile } from "@earendil-works/pi-schema";
import { expect, test } from "@playwright/test";
import { WS_METHOD_SCHEMAS, type WsParams } from "@thinkrail/contracts";
import { openFixtureProject, pressPlatformShortcut, worktreeRows } from "./fixtures/app";
import { readPersistedWorkspaces } from "./fixtures/storedState";
import { readRequest } from "./fixtures/wire";

const SESSION_PROMPT_PARAMS = compile(WS_METHOD_SCHEMAS["session.prompt"].params);

test("a start from the palette's typed text reaches the Create-workspace dialog prefilled, and Create sends exactly that prompt to the new workspace", {
	tag: "@agent",
}, async ({ page }) => {
	test.setTimeout(150_000);
	const prompts: WsParams<"session.prompt">[] = [];
	page.on("websocket", (socket) =>
		socket.on("framesent", ({ payload }) => {
			const frame = readRequest(String(payload), "session.prompt", SESSION_PROMPT_PARAMS);
			if (frame) prompts.push(frame.params);
		}),
	);
	await openFixtureProject(page);
	await expect(worktreeRows(page)).toHaveCount(0);

	await pressPlatformShortcut(page, "k");
	await expect(page.getByTestId("search-palette")).toBeVisible();
	const prompt = "Add a one-line description of this project to the top of README.md.";
	await page.getByTestId("search-input").fill(prompt);
	await expect(page.locator('[data-testid="search-row"][data-item-id="start"]')).toBeVisible();
	await pressPlatformShortcut(page, "Enter");
	await expect(page.getByTestId("search-palette")).toBeHidden();
	const dialog = page.getByTestId("new-workspace-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId("ws-prompt")).toHaveValue(prompt);
	const known = new Set(readPersistedWorkspaces().map((workspace) => workspace.id));
	await page.getByTestId("create-workspace").click();
	await expect(dialog).toBeHidden();

	await expect
		.poll(() => readPersistedWorkspaces().filter((workspace) => !known.has(workspace.id)).length)
		.toBe(1);
	await expect.poll(() => prompts.length, { timeout: 30_000 }).toBe(1);
	expect(prompts[0]?.text).toBe(prompt);
	await expect(
		page.locator('[data-testid="chat-message"][data-role="user"]').first(),
	).toContainText("one-line description");
	await expect(
		page.locator('[data-testid="chat-message"][data-role="assistant"]').first(),
	).toBeVisible({ timeout: 80_000 });
	await expect(page.getByTestId("chat-scroll")).toHaveAttribute("data-streaming", "false", {
		timeout: 100_000,
	});
});
