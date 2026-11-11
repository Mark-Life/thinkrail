import { realpathSync } from "node:fs";
import { compile } from "@earendil-works/pi-schema";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { WsParams } from "@thinkrail/contracts";
import { WS_METHOD_SCHEMAS } from "@thinkrail/contracts";
import { enterDefaultWorkspace, openFixtureProject } from "./fixtures/app";
import { E2E_FIXTURE_REPO } from "./fixtures/paths";
import { seedWorkspaceSession } from "./fixtures/sessions";
import { readRequest } from "./fixtures/wire";

const SESSION_PROMPT_PARAMS = compile(WS_METHOD_SCHEMAS["session.prompt"].params);

const BASE_TS = 1_700_700_000_000;

type PromptParams = WsParams<"session.prompt">;

async function interceptTryAgain(page: Page, prompts: PromptParams[]): Promise<void> {
	await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((message) => {
			const frame = readRequest(message.toString(), "session.prompt", SESSION_PROMPT_PARAMS);
			if (frame?.params.text === "Try again.") {
				prompts.push(frame.params);
				ws.send(JSON.stringify({ id: frame.id, ok: true, result: { ok: true } }));
				return;
			}
			server.send(message);
		});
		server.onMessage((message) => ws.send(message));
	});
}

test("a final agent failure offers Try again as an ordinary visible prompt", async ({ page }) => {
	const prompts: PromptParams[] = [];
	await interceptTryAgain(page, prompts);
	await openFixtureProject(page);

	const chat = seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: "network failure chat",
		messages: [
			{ role: "user", text: "finish the task", timestamp: BASE_TS },
			{
				role: "assistant",
				text: "I was checking the final step",
				timestamp: BASE_TS + 1_000,
				stopReason: "error",
				errorMessage: "fetch failed",
			},
		],
	});

	await enterDefaultWorkspace(page);
	await expect(page.locator('[data-testid="editor-tab"][data-kind="chat"]')).toHaveCount(1);

	const failure = page
		.locator('[data-testid="chat-message"][data-role="error"]')
		.filter({ hasText: "fetch failed" });
	await expect(failure).toBeVisible();
	const tryAgain = failure.getByTestId("agent-try-again");
	await expect(tryAgain).toHaveText("Try again");

	await tryAgain.click();

	await expect(page.getByTestId("agent-try-again")).toHaveCount(0);
	await expect(
		page
			.locator('[data-testid="chat-message"][data-role="user"]')
			.filter({ hasText: "Try again." }),
	).toHaveCount(1);
	await expect.poll(() => prompts.at(-1)).toEqual({ sessionId: chat.id, text: "Try again." });
	expect(prompts).toHaveLength(1);
});

test("a subscription-limit failure offers the usage page and provider settings instead of Try again", async ({
	page,
}) => {
	await openFixtureProject(page);
	const errorMessage =
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."}}';
	seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: "extra usage chat",
		messages: [
			{ role: "user", text: "finish the task", timestamp: BASE_TS },
			{
				role: "assistant",
				text: "",
				timestamp: BASE_TS + 1_000,
				stopReason: "error",
				errorMessage,
			},
		],
	});

	await enterDefaultWorkspace(page);
	const failure = page
		.locator('[data-testid="chat-message"][data-role="error"]')
		.filter({ hasText: "Third-party apps now draw from your extra usage" });
	await expect(failure).toBeVisible();
	await expect(failure.getByTestId("agent-try-again")).toHaveCount(0);
	await expect(failure.getByRole("link", { name: "Manage extra usage" })).toHaveAttribute(
		"href",
		"https://claude.ai/settings/usage",
	);

	await failure.getByTestId("agent-open-provider-settings").click();
	await expect(page.getByTestId("settings-providers")).toBeVisible();
});
