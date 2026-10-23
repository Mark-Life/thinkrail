import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { pressPlatformShortcut } from "./fixtures/app";
import { banner, openWorkspaceWithFile, typeAtLineEnd, visibleEditor } from "./fixtures/fileEdit";

function parseFrame(message: string | Buffer): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(String(message));
		return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

test("a file that changes on disk while it opens shows the new text and saves without a conflict", async ({
	page,
}) => {
	const name = "racing.ts";
	let holdRead = false;
	let heldId: unknown;
	let releaseRead: (() => void) | null = null;
	let fsChangeSeen = false;
	await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			const frame = parseFrame(message);
			const params = frame?.params as { path?: string } | undefined;
			if (holdRead && frame?.method === "fs.readFile" && params?.path === name) {
				holdRead = false;
				heldId = frame.id;
			}
			server.send(message);
		});
		server.onMessage((message) => {
			const frame = parseFrame(message);
			if (heldId !== undefined && frame?.id === heldId) {
				heldId = undefined;
				releaseRead = () => socket.send(message);
				return;
			}
			if (frame?.channel === "workspace.fsChanged" && String(message).includes(name)) {
				if (fsChangeSeen) return;
				fsChangeSeen = true;
			}
			socket.send(message);
		});
	});
	const path = await openWorkspaceWithFile(page, name, "const old = 1;\n");

	holdRead = true;
	await page.getByTestId("file-node").filter({ hasText: name }).dblclick();
	await expect.poll(() => releaseRead !== null).toBe(true);
	writeFileSync(path, "const agent = 2;\n");
	await expect.poll(() => fsChangeSeen, { timeout: 10_000 }).toBe(true);
	releaseRead?.();

	await expect(visibleEditor(page)).toBeVisible();
	await expect(page.locator("[data-file-buffer]")).toHaveCount(1);
	await expect(visibleEditor(page)).toContainText("const agent = 2;");
	await typeAtLineEnd(page, 1, " // mine");
	await pressPlatformShortcut(page, "s");
	await expect.poll(() => readFileSync(path, "utf8")).toBe("const agent = 2; // mine\n");
	await expect(banner(page)).toHaveCount(0);
});
