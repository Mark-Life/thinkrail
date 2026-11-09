import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { SessionId } from "@thinkrail/contracts";
import { WS_CHANNELS } from "@thinkrail/contracts";
import { testProjectId, testSessionId, testWorkspaceId } from "@thinkrail/contracts/test-ids";
import {
	defaultWorkspaceRow,
	enterDefaultWorkspace,
	openAppFresh,
	openFixtureProject,
} from "./fixtures/app";
import { E2E_DATA_DIR, E2E_FIXTURE_REPO } from "./fixtures/paths";
import { seedWorkspaceSession } from "./fixtures/sessions";
import { E2eWire } from "./fixtures/wire";

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

test("a project with a hand-edited id and a session with an edited header stay listed", async ({
	page,
}) => {
	await openFixtureProject(page);
	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	try {
		const worktree = realpathSync(E2E_FIXTURE_REPO);
		const workspace = (
			await wire.request("workspace.list", {
				projectId: (await wire.request("project.list", {}))[0]?.id ?? testProjectId(""),
			})
		).find((candidate) => candidate.kind === "default");
		if (!workspace) throw new Error("Missing default workspace");
		const edited = seedWorkspaceSession(worktree, {
			id: "edited header",
			name: "Edited header",
			messages: [{ role: "user", text: "An old session", timestamp: Date.now() }],
		});
		const sessions = await wire.request("session.list", { workspaceId: workspace.id });
		expect(sessions.map((session) => session.sessionId)).toContain(testSessionId(edited.id));

		writeFileSync(
			join(E2E_DATA_DIR, "projects.json"),
			JSON.stringify([
				{
					id: "hand-edited-project",
					name: "sample-project",
					path: E2E_FIXTURE_REPO,
					slug: "sample-project",
					lastOpened: Date.now(),
				},
			]),
		);
		await page.reload();
		await expect(
			page.getByTestId("project-item").filter({ hasText: "sample-project" }),
		).toBeVisible();
		await expect(page.getByTestId("project-item")).toHaveCount(1);
		const projects = await wire.request("project.list", {});
		expect(projects.map((project) => project.id)).toEqual([testProjectId("hand-edited-project")]);
	} finally {
		wire.close();
	}
});

test("a request with a bad id is refused over the socket", async ({ page }) => {
	await openFixtureProject(page);
	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	try {
		for (const id of ["", "w1", "../escape", "..%2Fescape", "a/b"]) {
			await expect(
				wire.request("workspace.list", { projectId: testProjectId(id) }),
			).rejects.toThrow("workspace.list failed");
			await expect(
				wire.request("session.list", { workspaceId: testWorkspaceId(id) }),
			).rejects.toThrow("session.list failed");
		}
		const workspaceId = testWorkspaceId("00000000-0000-4000-8000-0000000000b1");
		for (const id of ["", "../escape", "a/b", "a".repeat(201)]) {
			await expect(
				wire.request("session.resources", { workspaceId, sessionId: testSessionId(id) }),
			).rejects.toThrow("session.resources failed");
		}
	} finally {
		wire.close();
	}
});
