import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { enterDefaultWorkspace, openFixtureProject, openPersistedChat } from "../../fixtures/app";
import { E2E_FIXTURE_REPO } from "../../fixtures/paths";
import { seedWorkspaceSession } from "../../fixtures/sessions";
import { chatHistory } from "../chatReplay";
import {
	installPageProbe,
	SHIFT_REGIONS,
	TRACKED_ELEMENTS,
	type WaterfallRecord,
	type WireFrame,
	wireTimeline,
} from "./waterfallProbe";

const OUT_DIR = process.env.THINKRAIL_PERF_WATERFALL_OUT;
const CHAT_VIEW_CHUNK = /\/ChatView-[^/]+\.js$/;
const SETTLE_MS = 1_500;
const TITLE = "Waterfall restore";

function pause(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function assistantMessage(page: Page) {
	return page.locator('[data-testid="chat-message"][data-role="assistant"]').first();
}

test.skip(!OUT_DIR, "driven by perf:compare (THINKRAIL_PERF_WATERFALL_OUT)");

test("restore waterfall", async ({ page, browserName }) => {
	await openFixtureProject(page);
	seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name: TITLE,
		messages: chatHistory(1_700_900_000_000, 24),
	});
	await enterDefaultWorkspace(page);
	await openPersistedChat(page, TITLE);
	await expect(assistantMessage(page)).toBeVisible();

	await page.addInitScript(installPageProbe, {
		regions: SHIFT_REGIONS,
		tracked: TRACKED_ELEMENTS,
	});
	await page.route("**/*", (route) => route.continue());
	const frames: WireFrame[] = [];
	let chatViewChunkMs: number | null = null;
	let startedAt = 0;
	const elapsed = () => performance.now() - startedAt;
	page.on("websocket", (socket) => {
		if (!/\/ws(\?|$)/.test(socket.url())) return;
		socket.on("framesent", ({ payload }) =>
			frames.push({ at: elapsed(), direction: "sent", payload: String(payload) }),
		);
		socket.on("framereceived", ({ payload }) =>
			frames.push({ at: elapsed(), direction: "received", payload: String(payload) }),
		);
	});
	page.on("requestfinished", (request) => {
		if (chatViewChunkMs === null && CHAT_VIEW_CHUNK.test(new URL(request.url()).pathname)) {
			chatViewChunkMs = elapsed();
		}
	});

	startedAt = performance.now();
	await page.reload();
	await expect(page.getByTestId("chat-input")).toBeEditable({ timeout: 30_000 });
	await expect(assistantMessage(page)).toBeVisible({ timeout: 30_000 });
	await pause(SETTLE_MS);
	const snapshot = await page.evaluate(() => window.__thinkrailWaterfallProbe?.snapshot() ?? null);
	if (!snapshot) throw new Error("waterfall page probe did not install");

	const record: WaterfallRecord = {
		browser: browserName,
		wire: wireTimeline(frames),
		chatViewChunkMs,
		page: snapshot,
	};
	if (!OUT_DIR) return;
	mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(join(OUT_DIR, "waterfall.json"), JSON.stringify(record));
	writeFileSync(join(OUT_DIR, "wire-frames.json"), JSON.stringify(frames));
});
