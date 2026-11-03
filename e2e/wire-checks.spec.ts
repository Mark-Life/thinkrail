import { realpathSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import type { SessionId } from "@thinkrail/contracts";
import { WS_CHANNELS } from "@thinkrail/contracts";
import {
	defaultWorkspaceRow,
	enterDefaultWorkspace,
	openAppFresh,
	openFixtureProject,
} from "./fixtures/app";
import { E2E_FIXTURE_REPO } from "./fixtures/paths";
import { seedWorkspaceSession } from "./fixtures/sessions";

interface Frame {
	id?: string;
	method?: string;
	params?: { sessionId?: SessionId; boundary?: string };
	channel?: string;
	data?: unknown;
	result?: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

async function rewriteHostFrames(
	page: Page,
	rewrite: (frame: Frame & Record<string, unknown>) => void,
): Promise<void> {
	await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((message) => server.send(message));
		server.onMessage((message) => {
			const frame = JSON.parse(String(message)) as Frame & Record<string, unknown>;
			rewrite(frame);
			ws.send(JSON.stringify(frame));
		});
	});
}

test("a reply that fails its schema is an error for that request, and only its method and code are reported", async ({
	page,
}) => {
	let unreadableId = "";
	const reports: unknown[] = [];
	await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((message) => {
			const frame = JSON.parse(String(message)) as Frame;
			if (frame.method === "client.reportError") reports.push(frame.params);
			if (frame.method === "session.getMessages" && frame.params?.sessionId === unreadableId) {
				ws.send(JSON.stringify({ id: frame.id, ok: true, result: { wrong: "shape" } }));
				return;
			}
			server.send(message);
		});
		server.onMessage((message) => ws.send(message));
	});
	await openFixtureProject(page);
	const unreadable = seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: "the refused chat",
		messages: [{ role: "user", text: "cannot read me", timestamp: 1_700_400_000_000 }],
	});
	unreadableId = unreadable.id;

	await enterDefaultWorkspace(page);

	await expect(
		page
			.locator('[data-testid="toast"][data-variant="error"]')
			.filter({ hasText: "that this app cannot read" }),
	).toBeVisible();
	await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
	await expect
		.poll(() => reports)
		.toContainEqual({
			kind: "rejection",
			type: "RequestError",
			boundary: "INVALID_REPLY:session.getMessages",
		});
});

test("extra fields, bad pushes and channels of a newer host leave the app working", async ({
	page,
}) => {
	const errors: Error[] = [];
	page.on("pageerror", (error) => errors.push(error));
	await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((message) => server.send(message));
		server.onMessage((message) => {
			const frame = JSON.parse(String(message)) as Frame & Record<string, unknown>;
			frame.fromNewerHost = true;
			if (isObject(frame.data)) frame.data.fromNewerHost = true;
			if (isObject(frame.result)) frame.result.fromNewerHost = true;
			ws.send("not json");
			ws.send(JSON.stringify({ channel: "from.a.newer.host", data: {} }));
			ws.send(JSON.stringify({ channel: WS_CHANNELS.workspaceRemoved, data: { projectId: 7 } }));
			ws.send(JSON.stringify(frame));
		});
	});
	await openFixtureProject(page);
	await enterDefaultWorkspace(page);
	await expect(defaultWorkspaceRow(page)).toBeVisible();
	expect(errors).toEqual([]);
});

test("a welcome from an older host with no recent projects or config still starts the app", async ({
	page,
}) => {
	await rewriteHostFrames(page, (frame) => {
		if (frame.channel !== WS_CHANNELS.serverWelcome || !isObject(frame.data)) return;
		delete frame.data.recentProjects;
		delete frame.data.config;
		delete frame.data.hostPlatform;
		delete frame.data.appVersion;
	});
	await openAppFresh(page);
	await page.getByRole("button", { name: "Skip setup" }).click();
	await page.getByTestId("add-project-menu").click();
	await page.getByTestId("menu-open-project").click();
	await expect(defaultWorkspaceRow(page)).toBeVisible();
});
