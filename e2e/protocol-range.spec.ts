import { expect, type Page, test } from "@playwright/test";
import {
	PROTOCOL_MAX_VERSION,
	PROTOCOL_MIN_VERSION,
	PROTOCOL_VERSION,
	type ServerWelcome,
	WS_CHANNELS,
} from "@thinkrail/contracts";
import { openAppFresh, openFixtureProject } from "./fixtures/app";

type WelcomeEdit = Partial<
	Pick<ServerWelcome, "protocolVersion" | "protocolMin" | "protocolMax">
> | null;

const ABOVE_RANGE = { protocolVersion: PROTOCOL_MAX_VERSION + 1 };
const BELOW_RANGE = { protocolVersion: PROTOCOL_MIN_VERSION - 1 };

async function editWelcome(page: Page, initial: WelcomeEdit = null) {
	let edit = initial;
	let reconnect = () => {};
	const welcomes: ServerWelcome[] = [];
	await page.routeWebSocket(/\/ws(\?|$)/, (browser) => {
		const server = browser.connectToServer();
		reconnect = () => browser.close({ code: 1012, reason: "Reconnect probe" });
		browser.onMessage((message) => server.send(message));
		server.onMessage((message) => {
			const frame = JSON.parse(String(message)) as { channel?: string; data: ServerWelcome };
			if (frame.channel !== WS_CHANNELS.serverWelcome) {
				browser.send(message);
				return;
			}
			welcomes.push(frame.data);
			browser.send(JSON.stringify({ ...frame, data: { ...frame.data, ...edit } }));
		});
	});
	return {
		welcomes,
		change: (next: WelcomeEdit) => {
			edit = next;
		},
		reconnectWith: (next: WelcomeEdit) => {
			edit = next;
			reconnect();
		},
	};
}

const prompt = (page: Page) => page.getByTestId("protocol-mismatch-dialog");
const reload = (page: Page) => page.getByTestId("protocol-mismatch-reload");

test("a host at either end of the range opens the app with no prompt", async ({ page }) => {
	const host = await editWelcome(page, { protocolVersion: PROTOCOL_MIN_VERSION });
	await openFixtureProject(page);
	await expect(prompt(page)).toHaveCount(0);
	expect(host.welcomes[0]).toMatchObject({
		protocolVersion: PROTOCOL_VERSION,
		protocolMin: PROTOCOL_MIN_VERSION,
		protocolMax: PROTOCOL_MAX_VERSION,
	});

	const seen = host.welcomes.length;
	host.reconnectWith({ protocolVersion: PROTOCOL_MAX_VERSION });
	await expect.poll(() => host.welcomes.length).toBeGreaterThan(seen);
	await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
	await expect(page.getByTestId("project-item").first()).toBeVisible();
	await expect(prompt(page)).toHaveCount(0);
});

test("a UI older than its host offers Reload, cannot be dismissed, and Reload gets a new page", async ({
	page,
}) => {
	const host = await editWelcome(page);
	await openFixtureProject(page);

	host.reconnectWith(ABOVE_RANGE);
	await expect(prompt(page)).toHaveAttribute("data-mismatch", "uiOutdated");
	await expect(prompt(page)).toContainText("Reload to get the new interface");
	await page.keyboard.press("Escape");
	await expect(prompt(page)).toBeVisible();

	host.change(null);
	const loaded = page.waitForEvent("load");
	await reload(page).click();
	await loaded;
	await expect(page.getByTestId("project-item").first()).toBeVisible();
	await expect(prompt(page)).toHaveCount(0);
});

test("a newer host that dropped this UI's version also offers Reload", async ({ page }) => {
	await editWelcome(page, {
		protocolVersion: PROTOCOL_VERSION + 1,
		protocolMin: PROTOCOL_VERSION + 1,
	});
	await page.goto("/");
	await expect(prompt(page)).toHaveAttribute("data-mismatch", "uiOutdated");
	await expect(reload(page)).toBeVisible();
});

test("a UI newer than its host says to update the host, with no Reload, and clears once the host is updated", async ({
	page,
}) => {
	const host = await editWelcome(page, BELOW_RANGE);
	await openAppFresh(page);
	await expect(prompt(page)).toHaveAttribute("data-mismatch", "hostOutdated");
	await expect(prompt(page)).toContainText("Update ThinkRail on the host machine");
	await expect(reload(page)).toHaveCount(0);

	host.reconnectWith(null);
	await expect(prompt(page)).toHaveCount(0);
	await expect(page.getByTestId("welcome-action").first()).toBeVisible();
});

test("an older host whose range ends below this UI also says to update the host", async ({
	page,
}) => {
	await editWelcome(page, {
		protocolVersion: PROTOCOL_VERSION - 1,
		protocolMax: PROTOCOL_VERSION - 1,
	});
	await page.goto("/");
	await expect(prompt(page)).toHaveAttribute("data-mismatch", "hostOutdated");
	await expect(reload(page)).toHaveCount(0);
});
