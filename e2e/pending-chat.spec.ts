import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { enterDefaultWorkspace, openFixtureProject } from "./fixtures/app";

interface CreateRoute {
	requests: { id: string; sessionId?: string }[];
	release: () => void;
}

type CreateMode = "hold-reply" | "fail";

async function routeSessionCreate(page: Page, mode: CreateMode): Promise<CreateRoute> {
	let released = false;
	let deliver: (() => void) | undefined;
	const route: CreateRoute = {
		requests: [],
		release: () => {
			released = true;
			deliver?.();
		},
	};
	const hold = (send: () => void) => {
		if (released) send();
		else deliver = send;
	};
	let intercepting = true;
	await page.routeWebSocket(/\/ws(\?|$)/, (ws: WebSocketRoute) => {
		const server = ws.connectToServer();
		let heldId: string | undefined;
		ws.onMessage((message) => {
			try {
				const frame = JSON.parse(message.toString()) as {
					id?: string;
					method?: string;
					params?: { sessionId?: string };
				};
				if (intercepting && frame.method === "session.create" && frame.id) {
					intercepting = false;
					const id = frame.id;
					route.requests.push({
						id,
						...(frame.params?.sessionId ? { sessionId: frame.params.sessionId } : {}),
					});
					if (mode === "fail") {
						hold(() => ws.send(JSON.stringify({ id, ok: false, error: "session.create refused" })));
						return;
					}
					heldId = id;
				}
			} catch {}
			server.send(message);
		});
		server.onMessage((message) => {
			try {
				const frame = JSON.parse(message.toString()) as { id?: string };
				if (heldId !== undefined && frame.id === heldId) {
					heldId = undefined;
					hold(() => ws.send(message));
					return;
				}
			} catch {}
			ws.send(message);
		});
	});
	return route;
}

const chatTabs = (page: Page) => page.locator('[data-testid="editor-tab"][data-kind="chat"]');

async function startPendingChat(page: Page, route: CreateRoute): Promise<void> {
	await openFixtureProject(page);
	await enterDefaultWorkspace(page);
	await page.getByTestId("start-chat").first().click();
	await expect(chatTabs(page)).toHaveCount(1);
	await expect.poll(() => route.requests.length).toBe(1);
}

test("a new chat tab opens before session.create answers and holds send until it resolves", async ({
	page,
}) => {
	const route = await routeSessionCreate(page, "hold-reply");
	await startPendingChat(page, route);
	expect(route.requests[0]?.sessionId).toMatch(/^chat/);

	const input = page.getByTestId("chat-input");
	await expect(input).toHaveAttribute("placeholder", "Starting chat…");
	await input.fill("typed while starting");
	await expect(page.getByTestId("chat-send")).toBeDisabled();
	await expect(page.getByTestId("model-selector")).toBeDisabled();

	route.release();
	await expect(page.getByTestId("model-selector")).toBeEnabled({ timeout: 30_000 });
	await expect(input).not.toHaveAttribute("placeholder", "Starting chat…");
	await expect(input).toHaveValue("typed while starting");
	await expect(page.getByTestId("chat-send")).toBeEnabled();
	await expect(chatTabs(page)).toHaveCount(1);
});

test("a failed session.create discards the pending tab and explains why", async ({ page }) => {
	const route = await routeSessionCreate(page, "fail");
	await startPendingChat(page, route);
	await expect(page.getByTestId("chat-send")).toBeDisabled();

	route.release();
	await expect(chatTabs(page)).toHaveCount(0);
	const toast = page.locator('[data-testid="toast"][data-variant="error"]');
	await expect(toast).toContainText("Couldn't start the chat");
	await expect(toast).toContainText("session.create refused");
	await expect(page.getByTestId("start-chat").first()).toBeVisible();
});

test("a reload after the session.create reply is lost keeps the chat", async ({ page }) => {
	const route = await routeSessionCreate(page, "hold-reply");
	await startPendingChat(page, route);
	await expect(page.getByTestId("model-selector")).toBeDisabled();

	await page.reload();
	await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
	await expect(chatTabs(page)).toHaveCount(1);
	await expect(page.getByTestId("model-selector")).toBeEnabled({ timeout: 30_000 });
	await expect(page.getByTestId("chat-input")).not.toHaveAttribute("placeholder", "Starting chat…");
});
