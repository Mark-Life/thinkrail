import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import {
	type FsChangeAuthor,
	type WorkspaceFsChangedPayload,
	WS_CHANNELS,
} from "@thinkrail/contracts";
import { fileTab, openFile, typeAtLineEnd, visibleEditor } from "./fixtures/fileEdit";

const NAME = "presence.ts";
const LINES = Array.from({ length: 12 }, (_, index) => `const v${index + 1} = ${index + 1};`);
const BASE = `${LINES.join("\n")}\n`;
const AGENT: FsChangeAuthor = {
	kind: "agent",
	sessionId: "e2e-presence-agent",
	via: "tool",
	toolName: "edit",
};

const withLine = (text: string, line: number, next: string) =>
	text
		.split("\n")
		.map((current, index) => (index === line - 1 ? next : current))
		.join("\n");

async function routeFsAuthors(page: Page) {
	let agentPath: string | null = null;
	let author: FsChangeAuthor = AGENT;
	await page.routeWebSocket(/\/ws(\?|$)/, (browserSocket) => {
		const serverSocket = browserSocket.connectToServer();
		browserSocket.onMessage((message) => serverSocket.send(message));
		serverSocket.onMessage((message) => {
			if (typeof message !== "string" || agentPath === null) {
				browserSocket.send(message);
				return;
			}
			const frame = JSON.parse(message) as { channel?: string; data?: WorkspaceFsChangedPayload };
			const data = frame.data;
			if (frame.channel !== WS_CHANNELS.workspaceFsChanged || !data?.paths.includes(NAME)) {
				browserSocket.send(message);
				return;
			}
			const hash = createHash("sha256").update(readFileSync(agentPath)).digest("hex");
			const authors = { ...data.authors, [NAME]: { author, hash } };
			browserSocket.send(JSON.stringify({ ...frame, data: { ...data, authors } }));
		});
	});
	return {
		agentWrites(path: string | null, by: FsChangeAuthor = AGENT) {
			agentPath = path;
			author = by;
		},
	};
}

const marks = (page: Page, selector: string) => visibleEditor(page).locator(selector);

test("an agent write and an outside write show distinct marks, avatars and a tree dot; your own save shows none", async ({
	page,
}) => {
	const authors = await routeFsAuthors(page);
	const path = await openFile(page, NAME, BASE);

	await typeAtLineEnd(page, 1, " // mine");
	await expect.poll(() => readFileSync(path, "utf8"), { timeout: 10_000 }).toContain("// mine");
	await page.waitForTimeout(1500);
	await expect(marks(page, ".presence-bar")).toHaveCount(0);
	await expect(marks(page, "[data-presence]")).toHaveCount(0);
	await expect(fileTab(page, NAME).getByTestId("file-writer-avatars")).toHaveCount(0);
	await expect(page.getByTestId("file-writers")).toHaveCount(0);

	const editorTop = async () => (await visibleEditor(page).boundingBox())?.y;
	const topBefore = await editorTop();
	authors.agentWrites(path);
	writeFileSync(path, withLine(readFileSync(path, "utf8"), 4, "const v4 = 40;"));
	await expect(visibleEditor(page)).toContainText("const v4 = 40;", { timeout: 10_000 });
	await expect(page.getByTestId("file-writers")).toBeVisible();
	expect(await editorTop()).toBe(topBefore);
	await expect(marks(page, ".presence-bar.presence-tone-agent1")).toHaveCount(1);
	await expect(marks(page, '[data-presence="flag"]')).toHaveText(["Agent"]);
	await expect(marks(page, ".presence-bar.presence-inferred")).toHaveCount(0);
	await expect(marks(page, ".presence-bar.presence-tone-agent1")).toHaveAttribute(
		"title",
		"Changed by Agent",
	);

	authors.agentWrites(null);
	writeFileSync(path, withLine(readFileSync(path, "utf8"), 9, "const v9 = 90;"));
	await expect(visibleEditor(page)).toContainText("const v9 = 90;", { timeout: 10_000 });
	await expect(marks(page, ".presence-bar.presence-tone-external.presence-inferred")).toHaveCount(
		1,
	);
	await expect(marks(page, '[data-presence="flag"][data-writer="external"]')).toHaveText([
		"External",
	]);
	await expect(marks(page, ".presence-bar.presence-tone-agent1")).toHaveCount(1);
	await expect(visibleEditor(page)).toContainText("const v1 = 1; // mine");

	const avatars = fileTab(page, NAME).getByTestId("file-writer-avatar");
	await expect(avatars).toHaveCount(2);
	await expect(avatars.first()).toHaveAttribute("data-writer", "external");
	await expect(avatars.last()).toHaveAttribute("data-writer", `agent:${AGENT.sessionId}`);
	await expect(fileTab(page, NAME).getByTestId("file-writer-avatars")).toHaveAttribute(
		"aria-label",
		"Changed in the last minute by External, Agent",
	);

	const dot = page
		.getByTestId("file-node")
		.filter({ hasText: NAME })
		.getByTestId("file-writer-dot");
	await expect(dot).toHaveAttribute("data-tone", "external");
	await expect(dot).toHaveAttribute("aria-label", "Changed by External in the last minute");
	await expect(page.getByTestId("file-writers")).toContainText("2 writers");
	await expect(
		page.getByRole("button", { name: "2 writers: changed in the last minute by External, Agent" }),
	).toBeVisible();
	await page.getByTestId("file-writers").click();
	await expect(page.getByTestId("file-writers-list").getByRole("listitem")).toHaveText([
		"External",
		"Agent",
	]);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("status").filter({ hasText: "External changed line 9" })).toHaveCount(
		1,
	);

	await page.emulateMedia({ forcedColors: "active" });
	const barStyle = (selector: string) =>
		marks(page, selector).evaluate((node) => getComputedStyle(node, "::after").borderLeftStyle);
	expect(await barStyle(".presence-bar.presence-tone-agent1")).toBe("solid");
	expect(await barStyle(".presence-bar.presence-tone-external")).toBe("dashed");
});

test("a save from another window and an agent on one line draw bars in separate slots", async ({
	page,
}) => {
	const authors = await routeFsAuthors(page);
	const path = await openFile(page, NAME, BASE);

	authors.agentWrites(path);
	writeFileSync(path, withLine(readFileSync(path, "utf8"), 4, "const v4 = 40;"));
	await expect(marks(page, ".presence-bar.presence-tone-agent1")).toHaveCount(1, {
		timeout: 10_000,
	});

	authors.agentWrites(path, { kind: "user" });
	writeFileSync(path, withLine(readFileSync(path, "utf8"), 4, "const v4 = 400;"));
	const userBar = marks(page, ".presence-bar.presence-tone-user");
	await expect(userBar).toHaveCount(1, { timeout: 10_000 });
	await expect(userBar).toHaveAttribute("title", "Changed by You, in another window");
	await expect(marks(page, ".presence-bar.presence-tone-agent1")).toHaveCount(1);

	const barX = (selector: string) =>
		marks(page, selector).evaluate((node) => {
			const box = node.getBoundingClientRect();
			return box.right - Number.parseFloat(getComputedStyle(node, "::after").right);
		});
	const userX = await barX(".presence-bar.presence-tone-user");
	const agentX = await barX(".presence-bar.presence-tone-agent1");
	expect(Math.abs(userX - agentX)).toBeGreaterThanOrEqual(3);
	const lane = await marks(page, ".presence-bar.presence-tone-user").evaluate(
		(node) => node.getBoundingClientRect().left,
	);
	expect(userX - 2).toBeGreaterThanOrEqual(lane);
});

test("a touch tap on the writers chip lists the writers", async ({ page }) => {
	const authors = await routeFsAuthors(page);
	const path = await openFile(page, NAME, BASE);
	authors.agentWrites(path);
	writeFileSync(path, withLine(readFileSync(path, "utf8"), 4, "const v4 = 40;"));
	await expect(page.getByTestId("file-writers")).toBeVisible({ timeout: 10_000 });
	const chip = page.getByTestId("file-writers");
	for (const type of ["pointerdown", "pointerup"]) {
		await chip.dispatchEvent(type, { pointerType: "touch", isPrimary: true, button: 0 });
	}
	await chip.dispatchEvent("click");
	await expect(page.getByTestId("file-writers-list")).toContainText("Agent");
});

test("scrolled to the end, the writers chip leaves the last line clear", async ({ page }) => {
	const authors = await routeFsAuthors(page);
	const long = Array.from(
		{ length: 80 },
		(_, index) => `const v${index + 1} = "${"x".repeat(300)}";`,
	);
	const path = await openFile(page, NAME, `${long.join("\n")}\n`);
	await visibleEditor(page).locator(".view-line").first().click();
	await page.keyboard.press("Control+End");
	const last = visibleEditor(page).locator(".view-line").filter({ hasText: "const v80 =" });
	await expect(last).toHaveCount(1);
	authors.agentWrites(path);
	writeFileSync(path, withLine(readFileSync(path, "utf8"), 2, "const v2 = 2;"));
	const chip = page.getByTestId("file-writers");
	await expect(chip).toBeVisible({ timeout: 10_000 });
	const textBottom = () =>
		visibleEditor(page)
			.locator(".view-line")
			.evaluateAll((lines) =>
				Math.max(...lines.map((line) => line.getBoundingClientRect().bottom)),
			);
	await expect
		.poll(async () => ((await chip.boundingBox())?.y ?? 0) - (await textBottom()))
		.toBeGreaterThanOrEqual(0);
});
