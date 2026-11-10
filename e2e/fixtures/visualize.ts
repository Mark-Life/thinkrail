import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { DESKTOP_SHELL_GLOBAL, type ToolCall } from "@thinkrail/contracts";
import {
	enterDefaultWorkspace,
	expandDisclosure,
	openFixtureProject,
	openPersistedChat,
} from "./app";
import { readChatScrollGeometry, waitForScrollStability } from "./chatScroll";
import { E2E_FIXTURE_REPO } from "./paths";
import { seedWorkspaceSession } from "./sessions";

const BASE_TS = 1_700_920_000_000;
export const VISUALIZATION_FOLLOW_UP_TS = BASE_TS + 3_000;

export async function openVisualization(
	page: Page,
	name: string,
	args: ToolCall["arguments"],
	assistantText?: string,
): Promise<Locator> {
	return (await openVisualizationSession(page, name, args, assistantText)).card;
}

export async function openVisualizationSession(
	page: Page,
	name: string,
	args: ToolCall["arguments"],
	assistantText?: string,
): Promise<{ card: Locator; sessionId: string }> {
	const opened = await openVisualizationChat(
		page,
		name,
		args,
		assistantText === undefined
			? []
			: [
					{
						role: "assistant",
						text: assistantText,
						stopReason: "stop",
						timestamp: VISUALIZATION_FOLLOW_UP_TS,
					},
				],
	);
	const { card } = opened;
	await expect(card).toHaveCount(1);
	await expect(card).toBeVisible();
	await expect(card).toHaveAttribute("data-status", "done");
	await expect(card).toHaveAttribute("data-expanded", "true");
	await expect(card.getByTestId("tool-visualize")).toHaveAttribute("data-status", "done");
	return opened;
}

type SeededMessages = Parameters<typeof seedWorkspaceSession>[1]["messages"];

export async function openVisualizationChat(
	page: Page,
	name: string,
	args: ToolCall["arguments"],
	followUps: SeededMessages = [],
): Promise<{ card: Locator; sessionId: string }> {
	await openFixtureProject(page);
	const { id: sessionId } = seedWorkspaceSession(realpathSync(E2E_FIXTURE_REPO), {
		name,
		messages: [
			{ role: "user", text: "Show the visualization.", timestamp: BASE_TS },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "visualize-1", name: "visualize", arguments: args }],
				stopReason: "toolUse",
				timestamp: BASE_TS + 1_000,
			},
			{
				role: "toolResult",
				toolCallId: "visualize-1",
				toolName: "visualize",
				content: [{ type: "text", text: "Visualization complete." }],
				details: args,
				isError: false,
				timestamp: BASE_TS + 2_000,
			},
			...followUps,
		],
	});
	await enterDefaultWorkspace(page);
	await openPersistedChat(page, name);
	return { card: page.locator('[data-testid="tool-card"][data-tool="visualize"]'), sessionId };
}

export const MOCKUP_DIR = ".thinkrail/context/mockups";

export function writeMockups(files: Record<string, string>): () => void {
	const dir = join(E2E_FIXTURE_REPO, MOCKUP_DIR);
	mkdirSync(dir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	return () => rmSync(join(E2E_FIXTURE_REPO, ".thinkrail"), { recursive: true, force: true });
}

export const mockupHtml = (label: string) =>
	`<!doctype html><html><body><main><h1>Settings</h1><span class="cta">${label}</span></main></body></html>`;

export async function openAppearance(page: Page): Promise<Locator> {
	await page.getByTestId("open-settings").click();
	const dialog = page.getByTestId("settings-dialog");
	await expect(dialog).toBeVisible();
	await page.getByTestId("settings-nav-appearance").click();
	await expect(dialog).toContainText("Theme");
	// The fixed-mode theme list sits in a collapsed disclosure.
	await expandDisclosure(dialog.getByTestId("theme-toggle"));
	return dialog;
}

export async function pickTheme(page: Page, id: string): Promise<void> {
	const dialog = await openAppearance(page);
	await dialog.locator(`[data-theme-id="${id}"]`).click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", id);
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
}

export async function nodeColors(node: Locator): Promise<{ actual: string; expected: string }> {
	return node.evaluate((element) => {
		const probe = document.createElement("div");
		probe.style.backgroundColor = "var(--container-elevated-bg)";
		document.body.append(probe);
		const expected = getComputedStyle(probe).backgroundColor;
		probe.remove();
		return { actual: getComputedStyle(element).fill, expected };
	});
}

export async function installDesktopShellMarker(page: Page): Promise<void> {
	await page.addInitScript((name) => {
		Object.defineProperty(globalThis, name, { value: true });
	}, DESKTOP_SHELL_GLOBAL);
}

export async function hostColor(app: Page, token: string): Promise<string> {
	return app.evaluate((name) => {
		const probe = document.createElement("div");
		probe.style.backgroundColor = `var(${name})`;
		document.body.append(probe);
		const color = getComputedStyle(probe).backgroundColor;
		probe.remove();
		return color;
	}, token);
}

export async function oppositeTheme(app: Page): Promise<{ current: string; opposite: string }> {
	const dialog = await openAppearance(app);
	const options = await dialog.locator('[data-testid^="theme-option-"]').evaluateAll((elements) =>
		elements.map((element) => ({
			id: element.getAttribute("data-theme-id") ?? "",
			appearance: element.getAttribute("data-appearance"),
			active: element.getAttribute("data-active") === "true",
		})),
	);
	await app.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	const current = options.find((option) => option.active);
	const opposite = options.find((option) => option.appearance !== current?.appearance);
	if (!current || !opposite) throw new Error("No opposite appearance theme");
	return { current: current.id, opposite: opposite.id };
}

export const boxHeight = async (box: Locator) => Math.round((await box.boundingBox())?.height ?? 0);

export function heightsOverFrames(element: Locator, frames = 45): Promise<number[]> {
	return element.evaluate(async (node, count) => {
		const heights = [node.getBoundingClientRect().height];
		for (let frame = 0; frame < count; frame += 1) {
			await new Promise(requestAnimationFrame);
			const height = node.getBoundingClientRect().height;
			if (height !== heights.at(-1)) heights.push(height);
		}
		return heights;
	}, frames);
}

export const FRAME_SIZED_STYLES = {
	"a viewport-height body with the default margin":
		"body { min-height: 100vh; } #block { height: 300px; }",
	"a full-height app shell": "html, body { height: 100%; margin: 0; } #block { height: 900px; }",
	"a height media query that flips with the frame":
		"body { margin: 0; } #block { height: 150px; } @media (max-height: 399px) { #block { height: 800px; } }",
} as const;

const WHEEL_STEP = 120;
const WHEEL_SLACK = 5;

export async function expectRemountedCardKeepsRows(
	app: Page,
	name: string,
	file: string,
): Promise<void> {
	const { card } = await openVisualizationChat(
		app,
		name,
		{ type: "file", path: `${MOCKUP_DIR}/${file}` },
		Array.from({ length: 40 }, (_, index) => ({
			role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
			text: `Follow-up ${index}: ${"more words in this message. ".repeat(12)}`,
			...(index % 2 === 0 ? {} : { stopReason: "stop" as const }),
			timestamp: VISUALIZATION_FOLLOW_UP_TS + index * 1_000,
		})),
	);
	const chatScroll = app.getByTestId("chat-scroll");
	const box = card.getByTestId("html-frame-box");
	const wheelTo = async (edge: "distanceFromStart" | "distanceFromEnd", step: number) => {
		const { center } = await readChatScrollGeometry(chatScroll);
		await app.mouse.move(center.x, center.y);
		await expect
			.poll(
				async () => {
					await app.mouse.wheel(0, step);
					return (await readChatScrollGeometry(chatScroll))[edge];
				},
				{ timeout: 20_000, intervals: [100] },
			)
			.toBeLessThanOrEqual(1);
	};

	await wheelTo("distanceFromStart", -600);
	await expect(box).toHaveAttribute("data-content-height", "1600");
	await waitForScrollStability(chatScroll);
	await wheelTo("distanceFromEnd", 600);
	await expect(card).toHaveCount(0);
	await waitForScrollStability(chatScroll);

	await chatScroll.evaluate((root) => {
		const scroller = root.querySelector<HTMLElement>("[data-virtuoso-scroller]");
		if (!scroller) throw new Error("missing Virtuoso scroller");
		const frames: Record<string, [number, number]>[] = [];
		Reflect.set(window, "__rowEdges", frames);
		const sample = () => {
			const { top, bottom } = scroller.getBoundingClientRect();
			const edges: Record<string, [number, number]> = {};
			for (const row of scroller.querySelectorAll<HTMLElement>('[data-testid="chat-row"]')) {
				const rect = row.getBoundingClientRect();
				if (rect.bottom > top && rect.top < bottom) {
					edges[row.dataset.chatRowIndex ?? ""] = [rect.top, rect.bottom];
				}
			}
			frames.push(edges);
			if (Reflect.get(window, "__rowEdges") === frames) requestAnimationFrame(sample);
		};
		sample();
	});
	for (let step = 0; step < 200 && (await card.count()) === 0; step += 1) {
		await app.mouse.wheel(0, -WHEEL_STEP);
	}
	await expect(box).toHaveAttribute("data-content-height", "1600");
	for (let step = 0; step < 10; step += 1) await app.mouse.wheel(0, -WHEEL_STEP);
	await waitForScrollStability(chatScroll);
	const frames: Record<string, [number, number]>[] = await app.evaluate(() => {
		const recorded = Reflect.get(window, "__rowEdges");
		Reflect.set(window, "__rowEdges", null);
		return recorded;
	});

	const jumps: string[] = [];
	for (const [index, edges] of frames.entries()) {
		const previous = frames[index - 1] ?? edges;
		const kept = Object.keys(edges).filter((row) => previous[row] !== undefined);
		if (kept.length === 0) jumps.push(`frame ${index}: no row stayed on screen`);
		for (const row of kept) {
			for (const edge of [0, 1] as const) {
				const moved = (edges[row]?.[edge] ?? 0) - (previous[row]?.[edge] ?? 0);
				if (moved < -WHEEL_SLACK || moved > 2 * WHEEL_STEP + WHEEL_SLACK) {
					jumps.push(`frame ${index}: row ${row} moved ${Math.round(moved)}px`);
				}
			}
		}
	}
	expect(frames.length).toBeGreaterThan(10);
	expect(jumps).toEqual([]);
}
