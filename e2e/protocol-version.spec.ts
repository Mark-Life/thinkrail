import { expect, type Page, test } from "@playwright/test";
import { PROTOCOL_VERSION, type ServerWelcome, WS_CHANNELS } from "@thinkrail/contracts";
import { openAppFresh, openFixtureProject } from "./fixtures/app";

type WelcomeEdit = Partial<Record<keyof ServerWelcome, unknown>> | null;

const NEWER_HOST = { protocolVersion: PROTOCOL_VERSION + 1 };
const OLDER_HOST = { protocolVersion: PROTOCOL_VERSION - 1 };

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

test("a host at this UI's version opens the app with no prompt", async ({ page }) => {
	const host = await editWelcome(page);
	await openFixtureProject(page);
	await expect(prompt(page)).toHaveCount(0);
	expect(host.welcomes[0]?.protocolVersion).toBe(PROTOCOL_VERSION);

	const seen = host.welcomes.length;
	host.reconnectWith(null);
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

	host.reconnectWith(NEWER_HOST);
	await expect(prompt(page)).toHaveAttribute("data-mismatch", "uiOutdated");
	await expect(prompt(page)).toContainText("Reload to get the new interface");
	await expect(prompt(page)).toContainText("update this app");
	await page.keyboard.press("Escape");
	await expect(prompt(page)).toBeVisible();

	host.change(null);
	const loaded = page.waitForEvent("load");
	await reload(page).click();
	await loaded;
	await expect(page.getByTestId("project-item").first()).toBeVisible();
	await expect(prompt(page)).toHaveCount(0);
});

test("a UI newer than its host offers Reload, and clears once the host answers at its version", async ({
	page,
}) => {
	const host = await editWelcome(page, OLDER_HOST);
	await openAppFresh(page);
	await expect(prompt(page)).toHaveAttribute("data-mismatch", "hostOutdated");
	await expect(prompt(page)).toContainText("Reload to get this host's interface");

	host.change(null);
	const loaded = page.waitForEvent("load");
	await reload(page).click();
	await loaded;
	await expect(prompt(page)).toHaveCount(0);
	await expect(page.getByTestId("welcome-action").first()).toBeVisible();

	host.reconnectWith(OLDER_HOST);
	await expect(prompt(page)).toHaveAttribute("data-mismatch", "hostOutdated");
	host.reconnectWith(null);
	await expect(prompt(page)).toHaveCount(0);
});

for (const [field, broken] of [
	["projects", { byId: {} }],
	["config", null],
	["hostPlatform", 1],
] as const) {
	test(`a newer host that changed ${field} still gets the prompt`, async ({ page }) => {
		await editWelcome(page, { ...NEWER_HOST, [field]: broken });
		await page.goto("/");
		await expect(prompt(page)).toHaveAttribute("data-mismatch", "uiOutdated");
		await expect(reload(page)).toBeVisible();
	});
}

test("a broken welcome at this version gets the prompt, and the next good one clears it", async ({
	page,
}) => {
	const host = await editWelcome(page);
	await openFixtureProject(page);

	const warned = page.waitForEvent("console", (message) =>
		message.text().includes("refused the host's welcome"),
	);
	host.reconnectWith({ projects: { byId: {} } });
	await warned;
	await expect(prompt(page)).toHaveAttribute("data-mismatch", "uiOutdated");

	host.reconnectWith(null);
	await expect(prompt(page)).toHaveCount(0);
	await expect(page.getByTestId("project-item").first()).toBeVisible();
});

test("a first welcome that is broken at this version gets the prompt", async ({ page }) => {
	await editWelcome(page, { projects: { byId: {} } });
	await page.goto("/");
	await expect(prompt(page)).toHaveAttribute("data-mismatch", "uiOutdated");
	await expect(reload(page)).toBeVisible();
});

for (const [name, version] of [
	["no", undefined],
	["a string", String(PROTOCOL_VERSION)],
] as const) {
	test(`a welcome with ${name} version reaches the prompt`, async ({ page }) => {
		await editWelcome(page, { protocolVersion: version });
		await page.goto("/");
		await expect(prompt(page)).toHaveAttribute("data-mismatch", "uiOutdated");
		await expect(reload(page)).toBeVisible();
	});
}
