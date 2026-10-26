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
			const authors = { ...data.authors, [NAME]: { author: AGENT, hash } };
			browserSocket.send(JSON.stringify({ ...frame, data: { ...data, authors } }));
		});
	});
	return {
		agentWrites(path: string | null) {
			agentPath = path;
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
	await expect(page.getByRole("status").filter({ hasText: "External changed line 9" })).toHaveCount(
		1,
	);

	await page.emulateMedia({ forcedColors: "active" });
	const barStyle = (selector: string) =>
		marks(page, selector).evaluate((node) => getComputedStyle(node, "::after").borderLeftStyle);
	expect(await barStyle(".presence-bar.presence-tone-agent1")).toBe("solid");
	expect(await barStyle(".presence-bar.presence-tone-external")).toBe("dashed");
});
