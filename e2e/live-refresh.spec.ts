import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { createWorkspaceViaDialog, openFixtureProject, revealWorkbenchTool } from "./fixtures/app";
import { openFile, setFileSaveMode, typeAtLineEnd } from "./fixtures/fileEdit";
import { commitFile } from "./fixtures/git";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fsExpect = expect.configure({ timeout: 10_000 });

const longMarkdown = (version: string) =>
	`${Array.from(
		{ length: 300 },
		(_, index) => `## Section ${index}\n\n${version} paragraph ${index} with enough text to wrap.`,
	).join("\n\n")}\n`;

async function scrollDown(element: Locator) {
	return element.evaluate((node) => {
		node.scrollTop = (node.scrollHeight - node.clientHeight) * 0.6;
		node.dispatchEvent(new Event("scroll"));
		return node.scrollTop;
	});
}

test("a live rendered-diff refresh preserves the reader's scroll position", async ({ page }) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	const path = join(workspace.worktreePath, "scroll-refresh.md");
	commitFile(
		workspace.worktreePath,
		"scroll-refresh.md",
		longMarkdown("base"),
		"add scroll refresh fixture",
	);
	writeFileSync(path, longMarkdown("first refresh"));

	await revealWorkbenchTool(page, "changes");
	const change = page.getByTestId("change-item").filter({ hasText: "scroll-refresh.md" });
	await fsExpect(change).toBeVisible();
	await change.dblclick();
	const diff = page.getByTestId("rendered-diff");
	await fsExpect(diff).toContainText("first refresh paragraph 299");
	await expect
		.poll(() => diff.evaluate((node) => node.scrollHeight - node.clientHeight))
		.toBeGreaterThan(1_000);
	const diffTop = await scrollDown(diff);
	expect(diffTop).toBeGreaterThan(1_000);

	writeFileSync(path, longMarkdown("second refresh"));
	await fsExpect(diff).toContainText("second refresh paragraph 299");
	await expect.poll(() => diff.evaluate((node) => node.scrollTop)).toBeGreaterThan(diffTop * 0.8);
});

test("a live rendered-diff refresh keeps an expanded run expanded", async ({ page }) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	const path = join(workspace.worktreePath, "expand-refresh.md");
	const doc = (ending: string) =>
		`${Array.from({ length: 12 }, (_, index) =>
			index === 10 ? `Paragraph ${index} ${ending}.` : `Paragraph ${index} stays put.`,
		).join("\n\n")}\n`;
	commitFile(workspace.worktreePath, "expand-refresh.md", doc("original"), "add expand fixture");
	writeFileSync(path, doc("first edit"));

	await revealWorkbenchTool(page, "changes");
	await page.getByTestId("changes-scope-trigger").click();
	await page.getByTestId("changes-scope-uncommitted").click();
	const change = page.getByTestId("change-item").filter({ hasText: "expand-refresh.md" });
	await fsExpect(change).toBeVisible();
	await change.dblclick();
	const diff = page.getByTestId("rendered-diff");
	await fsExpect(diff.locator("ins").filter({ hasText: "first" })).toBeVisible();
	await expect(diff).not.toContainText("Paragraph 0 stays put.");
	await diff.getByTestId("rendered-diff-collapsed").first().click();
	await expect(diff).toContainText("Paragraph 0 stays put.");

	writeFileSync(path, doc("second edit"));
	await fsExpect(diff.locator("ins").filter({ hasText: "second" })).toBeVisible();
	await expect(diff).toContainText("Paragraph 0 stays put.");
});

test("worktree changes on disk appear live in Specs, Files, Changes, and an open file tab", async ({
	page,
}) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	const worktree = workspace.worktreePath;

	await expect(page.locator('[data-testid="spec-node"][data-spec-id="sample-root"]')).toBeVisible();
	mkdirSync(join(worktree, "module-live"), { recursive: true });
	writeFileSync(
		join(worktree, "module-live", "SPEC.md"),
		"---\nid: sample-live\ntype: module-design\ntitle: Live Module\nparent: sample-root\n---\n\n## Responsibility\n\nWritten on disk mid-session by the e2e suite.\n",
	);
	await fsExpect(
		page.locator('[data-testid="spec-node"][data-spec-id="sample-live"]'),
	).toBeVisible();

	await revealWorkbenchTool(page, "files");
	const freshFile = page.getByTestId("file-node").filter({ hasText: "fresh-file.txt" });
	await expect(page.getByTestId("file-node").filter({ hasText: "README.md" })).toBeVisible();
	writeFileSync(join(worktree, "fresh-file.txt"), "hello\n");
	await fsExpect(freshFile).toBeVisible();
	rmSync(join(worktree, "fresh-file.txt"));
	await fsExpect(freshFile).toHaveCount(0);

	await revealWorkbenchTool(page, "changes");
	const readmeRow = page.getByTestId("change-item").filter({ hasText: "README.md" });
	await expect(
		page.getByTestId("change-item").filter({ hasText: "SPEC.md" }).first(),
	).toBeVisible();
	await expect(readmeRow).toHaveCount(0);
	writeFileSync(join(worktree, "README.md"), "# sample-project\n\nedited live by e2e\n");
	await fsExpect(readmeRow).toHaveAttribute("data-status", "modified");
	await readmeRow.dblclick();
	await page.getByTestId("view-toggle-code").click();
	await expect(
		page.getByTestId("diff-view").getByText("edited live by e2e", { exact: false }).last(),
	).toBeVisible();
	writeFileSync(join(worktree, "README.md"), "# sample-project\n\nedited twice by e2e\n");
	await fsExpect(
		page.getByTestId("diff-view").getByText("edited twice by e2e", { exact: false }).last(),
	).toBeVisible();

	await revealWorkbenchTool(page, "files");
	await page.getByTestId("file-node").filter({ hasText: "README.md" }).dblclick();
	await expect(page.getByTestId("editor-pane")).toContainText("edited twice by e2e");
	writeFileSync(join(worktree, "README.md"), "# sample-project\n\nlive tab reload\n");
	await fsExpect(page.getByTestId("editor-pane")).toContainText("live tab reload");
	await fsExpect(page.getByTestId("editor-pane")).not.toContainText("edited twice by e2e");
});

test("churn canary: a write storm coalesces to a few frames and the host stays responsive", async ({
	page,
	baseURL,
}) => {
	const fsFrameTimes: number[] = [];
	page.on("websocket", (ws) => {
		ws.on("framereceived", (frame) => {
			const payload = typeof frame.payload === "string" ? frame.payload : frame.payload.toString();
			if (payload.includes('"channel":"workspace.fsChanged"')) fsFrameTimes.push(Date.now());
		});
	});

	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	const worktree = workspace.worktreePath;

	await revealWorkbenchTool(page, "files");
	await expect(page.getByTestId("file-node").filter({ hasText: "README.md" })).toBeVisible();
	await sleep(1200);
	const framesBefore = fsFrameTimes.length;

	mkdirSync(join(worktree, "storm"), { recursive: true });
	let healthMs = -1;
	for (let burst = 0; burst < 20; burst++) {
		for (let i = 0; i < 10; i++) {
			writeFileSync(join(worktree, "storm", `f-${burst}-${i}.txt`), `${burst}:${i}\n`);
		}
		if (burst === 10) {
			const t0 = performance.now();
			const res = await fetch(`${baseURL}/health`);
			healthMs = performance.now() - t0;
			expect(res.ok).toBe(true);
		}
		await sleep(150);
	}
	writeFileSync(join(worktree, "storm-done.txt"), "done\n");
	await expect(page.getByTestId("file-node").filter({ hasText: "storm-done.txt" })).toBeVisible();
	await sleep(1500);

	await page.getByTestId("file-node").filter({ hasText: "storm" }).first().click();
	await expect(page.getByTestId("file-node").filter({ hasText: "f-19-9.txt" })).toBeVisible();

	const stormFrames = fsFrameTimes.length - framesBefore;
	expect(stormFrames).toBeGreaterThanOrEqual(2);
	expect(stormFrames).toBeLessThanOrEqual(8);
	expect(healthMs).toBeGreaterThanOrEqual(0);
	expect(healthMs).toBeLessThan(1000);
});

interface SocketLog {
	fsChanged: number[];
	writes: { id: string | null; sent: number; answered?: number }[];
	holdNextWriteMs: number;
}

function frameId(raw: string) {
	try {
		const frame: unknown = JSON.parse(raw);
		return frame !== null && typeof frame === "object" && "id" in frame ? String(frame.id) : null;
	} catch {
		return null;
	}
}

async function logFileSocket(page: Page) {
	const log: SocketLog = { fsChanged: [], writes: [], holdNextWriteMs: 0 };
	await page.routeWebSocket(/\/ws(\?|$)/, (browserSocket) => {
		const serverSocket = browserSocket.connectToServer();
		const held = new Map<string | null, number>();
		browserSocket.onMessage((message) => {
			const raw = message.toString();
			if (raw.includes('"method":"fs.writeFile"')) {
				const id = frameId(raw);
				log.writes.push({ id, sent: Date.now() });
				if (log.holdNextWriteMs > 0) held.set(id, log.holdNextWriteMs);
				log.holdNextWriteMs = 0;
			}
			serverSocket.send(message);
		});
		serverSocket.onMessage((message) => {
			const raw = message.toString();
			if (raw.includes('"channel":"workspace.fsChanged"')) log.fsChanged.push(Date.now());
			const id = frameId(raw);
			const write = id === null ? undefined : log.writes.find((candidate) => candidate.id === id);
			if (!write) {
				browserSocket.send(message);
				return;
			}
			const answer = () => {
				write.answered = Date.now();
				browserSocket.send(message);
			};
			const holdMs = held.get(write.id);
			if (holdMs === undefined) answer();
			else setTimeout(answer, holdMs);
		});
	});
	return log;
}

async function typeLogged(page: Page, text: string, keys: number[]) {
	for (const key of text) {
		keys.push(Date.now());
		await page.keyboard.type(key);
		await sleep(120);
	}
}

test("churn canary: typing with autosave on stays within the frame budget", async ({
	page,
	baseURL,
}) => {
	await setFileSaveMode(baseURL, "auto");
	const log = await logFileSocket(page);

	const path = await openFile(page, "typing.ts", "export const typed = [\n];\n");
	await sleep(1200);
	const framesBefore = log.fsChanged.length;

	const bursts = 3;
	const keys: number[] = [];
	for (let burst = 0; burst < bursts; burst++) {
		await typeAtLineEnd(page, 1, "");
		await typeLogged(page, ` ${burst}, 1, 2, 3, 4,`, keys);
		await sleep(1600);
	}

	await page.evaluate(() => {
		new MutationObserver(() => {
			if (document.querySelector('[data-testid="file-dirty-dot"]'))
				document.documentElement.dataset.pausedDotSeen = "true";
		}).observe(document.body, { childList: true, subtree: true, attributes: true });
	});
	log.holdNextWriteMs = 2500;
	await typeLogged(page, " 3,", keys);
	await expect.poll(() => log.writes.length).toBe(bursts + 1);
	await typeLogged(page, " 4,", keys);
	await expect
		.poll(() => readFileSync(path, "utf8"), { timeout: 10_000 })
		.toBe("export const typed = [ 0, 1, 2, 3, 4, 1, 1, 2, 3, 4, 2, 1, 2, 3, 4, 3, 4,\n];\n");
	await sleep(1500);

	const overlapping = keys.filter((key) =>
		log.writes.some(
			(write) => write.sent < key && key < (write.answered ?? Number.POSITIVE_INFINITY),
		),
	);
	const typingFrames = log.fsChanged.length - framesBefore;
	console.log(
		`churn canary (typing): ${typingFrames} fsChanged frames, ${log.writes.length} writes, ${overlapping.length} keys during a write`,
	);
	expect(overlapping.length).toBeGreaterThan(0);
	expect(log.writes).toHaveLength(bursts + 2);
	expect(typingFrames).toBeGreaterThanOrEqual(1);
	expect(typingFrames).toBeLessThanOrEqual(8);
	await expect(page.locator("html")).not.toHaveAttribute("data-paused-dot-seen", "true");
});
