import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { createWorkspaceViaDialog, openFixtureProject, revealWorkbenchTool } from "../fixtures/app";
import { E2eWire } from "../fixtures/wire";
import { assertProfilingReady } from "./renderProfiler";

const PLAN_STEPS = 18;
const PLAN_GROUPS = 3;
const WORKSPACE_RENAMES = 24;
const REVIEW_FILES = 8;
const COMMENTS_PER_FILE = 5;
const COMMENT_SELECTIONS = 24;

export type Measure = (
	page: Page,
	scenario: string,
	run: number,
	action: () => Promise<Record<string, number>>,
) => Promise<void>;

async function withWire<T>(page: Page, use: (wire: E2eWire) => Promise<T>): Promise<T> {
	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	try {
		return await use(wire);
	} finally {
		wire.close();
	}
}

function seedPlan(worktreePath: string, sessionId: string): void {
	const at = "2026-01-01T00:00:00Z";
	const groups = Array.from({ length: PLAN_GROUPS }, (_, group) => ({
		id: `g_${group + 1}`,
		title: `Plan phase ${group + 1}`,
		todos: Array.from({ length: PLAN_STEPS / PLAN_GROUPS }, (_, step) => ({
			id: `t_${group + 1}_${step + 1}`,
			title: `Plan step ${group + 1}.${step + 1}`,
			status: "pending",
			origin: "agent",
			createdAt: at,
			updatedAt: at,
		})),
	}));
	const dir = join(worktreePath, ".thinkrail", "context", "todos");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify({ version: 6, todos: [], groups }));
}

export async function planPane(page: Page, run: number, measure: Measure): Promise<void> {
	await openFixtureProject(page);
	await assertProfilingReady(page);
	const workspace = await createWorkspaceViaDialog(page);
	const sessionId = await page
		.locator('[data-testid="editor-tab"][data-kind="chat"]')
		.first()
		.getAttribute("data-session-id");
	if (!sessionId) throw new Error("chat tab exposes no session id");
	seedPlan(workspace.worktreePath, sessionId);
	await revealWorkbenchTool(page, "plan");
	const rail = page.getByTestId("plan-rail-pane");
	await expect(rail.getByTestId("todo-row")).toHaveCount(PLAN_STEPS);
	await rail.getByTestId("todo-open-plan").click();
	const pane = page.getByTestId("plan-pane");
	await expect(pane.getByTestId("plan-item")).toHaveCount(PLAN_STEPS);
	await expect(pane.getByTestId("plan-group")).toHaveCount(PLAN_GROUPS);

	await withWire(page, (wire) =>
		measure(page, "plan-pane", run, async () => {
			for (let rename = 1; rename <= WORKSPACE_RENAMES; rename += 1) {
				const name = `Plan rename ${run}-${rename}`;
				await wire.request("workspace.rename", { id: workspace.id, name });
				await expect(page.getByTestId("workspace-name").filter({ hasText: name })).toBeVisible();
			}
			return { renames: WORKSPACE_RENAMES, planSteps: PLAN_STEPS, planGroups: PLAN_GROUPS };
		}),
	);
}

function reviewFile(file: number) {
	return `review-${file + 1}.ts`;
}

export async function reviewPanel(page: Page, run: number, measure: Measure): Promise<void> {
	await openFixtureProject(page);
	await assertProfilingReady(page);
	const workspace = await createWorkspaceViaDialog(page);
	for (let file = 0; file < REVIEW_FILES; file += 1) {
		const lines = Array.from(
			{ length: COMMENTS_PER_FILE * 2 },
			(_, line) => `export const value${line} = ${file * 100 + line};`,
		);
		writeFileSync(join(workspace.worktreePath, reviewFile(file)), `${lines.join("\n")}\n`);
	}
	await revealWorkbenchTool(page, "review");
	await withWire(page, async (wire) => {
		for (let file = 0; file < REVIEW_FILES; file += 1) {
			for (let comment = 0; comment < COMMENTS_PER_FILE; comment += 1) {
				const line = comment * 2 + 1;
				await wire.request("review.commentAdd", {
					workspaceId: workspace.id,
					kind: "inline",
					anchor: {
						path: reviewFile(file),
						side: "worktree",
						selectors: [{ kind: "lineRange", startLine: line, endLine: line }],
					},
					body: `Review remark ${file + 1}.${comment + 1}`,
				});
			}
		}
	});
	const sections = page.getByTestId("review-file-section");
	await expect(sections).toHaveCount(REVIEW_FILES);
	for (let file = 0; file < REVIEW_FILES; file += 1) {
		const section = sections.and(page.locator(`[data-path="${reviewFile(file)}"]`));
		if ((await section.getAttribute("data-expanded")) !== "true")
			await section.getByTestId("review-file-row").click();
		await expect(section).toHaveAttribute("data-expanded", "true");
	}
	const comments = page.getByTestId("review-comment");
	await expect(comments).toHaveCount(REVIEW_FILES * COMMENTS_PER_FILE);
	const activeTab = page.locator('[data-testid="editor-tab"][data-active="true"]');

	await measure(page, "review-panel", run, async () => {
		for (let selection = 0; selection < COMMENT_SELECTIONS; selection += 1) {
			const file = selection % REVIEW_FILES;
			const comment = file * COMMENTS_PER_FILE + (selection % COMMENTS_PER_FILE);
			await comments.nth(comment).getByTestId("review-comment-open").click();
			await expect(activeTab).toContainText(reviewFile(file));
		}
		return { selections: COMMENT_SELECTIONS, comments: REVIEW_FILES * COMMENTS_PER_FILE };
	});
}
