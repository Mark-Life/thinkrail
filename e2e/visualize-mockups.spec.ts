import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { openAppFresh } from "./fixtures/app";
import {
	clickInTranscriptFrame,
	clickTranscriptControl,
	readChatScrollGeometry,
	waitForScrollStability,
} from "./fixtures/chatScroll";
import { E2E_FIXTURE_REPO } from "./fixtures/paths";
import {
	MOCKUP_DIR,
	openAppearance,
	openVisualization,
	openVisualizationChat,
	pickTheme,
	VISUALIZATION_FOLLOW_UP_TS,
	writeMockups,
} from "./fixtures/visualize";

const THEMED = "allow-same-origin";

const page = (body: string, style = "") =>
	`<!doctype html><html><head><link rel="stylesheet" href="thinkrail-theme.css"><style>body { margin: 0; } ${style}</style></head><body>${body}</body></html>`;

const themedMockup = page(
	'<div id="swatch"></div><div id="tall"></div><details><summary>More</summary><div id="more"></div></details>',
	"#swatch { height: 40px; background: var(--container-elevated-bg); } #tall { height: 880px; } summary { display: block; height: 20px; overflow: hidden; } #more { height: 300px; }",
);

const sizedMockup = (height: number) =>
	page('<div id="block"></div>', `#block { height: ${height}px; }`);

async function hostColor(app: Page, token: string): Promise<string> {
	return app.evaluate((name) => {
		const probe = document.createElement("div");
		probe.style.backgroundColor = `var(${name})`;
		document.body.append(probe);
		const color = getComputedStyle(probe).backgroundColor;
		probe.remove();
		return color;
	}, token);
}

function frameStyle(iframe: Locator, selector: string, property: string): Promise<string | null> {
	return iframe.evaluate(
		(frame, [target, name]) => {
			const view = (frame as HTMLIFrameElement).contentWindow;
			const element = view?.document.querySelector(target ?? "");
			return element && view ? view.getComputedStyle(element).getPropertyValue(name ?? "") : null;
		},
		[selector, property],
	);
}

async function oppositeTheme(app: Page): Promise<{ current: string; opposite: string }> {
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

const EDITS = 20;
const WHEEL_STEP = 120;
const WHEEL_SLACK = 5;

const boxHeight = async (box: Locator) => Math.round((await box.boundingBox())?.height ?? 0);

function heightsOverFrames(element: Locator, frames = 45): Promise<number[]> {
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

const frameSized = {
	"a viewport-height body with the default margin":
		"body { min-height: 100vh; } #block { height: 300px; }",
	"a full-height app shell": "html, body { height: 100%; margin: 0; } #block { height: 900px; }",
	"a height media query that flips with the frame":
		"body { margin: 0; } #block { height: 150px; } @media (max-height: 399px) { #block { height: 800px; } }",
} as const;

test("a mockup card sizes itself to the document and follows it as it grows", async ({
	page: app,
}) => {
	const cleanup = writeMockups({ "chart.html": themedMockup });
	try {
		const card = await openVisualization(app, "fitted mockup", {
			type: "file",
			path: `${MOCKUP_DIR}/chart.html`,
		});
		const preview = card.getByTestId("resource-preview");
		await expect(preview.getByTestId("html-view")).toHaveAttribute("data-html-mode", "themed");
		await expect(preview.getByTestId("html-disabled-notice")).toBeVisible();
		await expect(preview.locator("iframe")).toHaveAttribute("sandbox", THEMED);

		const box = preview.getByTestId("html-frame-box");
		await expect(box).toHaveAttribute("data-content-height", "940");
		await expect(preview).toHaveAttribute("data-natural-height", "true");
		await expect(box).toHaveAttribute("data-viewport", "responsive");
		await expect(box).toHaveAttribute("data-scale", "1.000");
		await expect.poll(() => boxHeight(box)).toBe(940);
		expect((await preview.boundingBox())?.height ?? 0).toBeGreaterThan(940);

		const summary = preview.frameLocator("iframe").locator("summary");
		await clickInTranscriptFrame(summary);
		await expect(box).toHaveAttribute("data-content-height", "1240");
		await expect.poll(() => boxHeight(box)).toBe(1240);
		await clickInTranscriptFrame(summary);
		await expect(box).toHaveAttribute("data-content-height", "940");
		await clickInTranscriptFrame(summary);
		await expect(box).toHaveAttribute("data-content-height", "1240");

		await clickTranscriptControl(preview.getByTestId("html-viewport-desktop"));
		await expect.poll(async () => Number(await box.getAttribute("data-scale"))).toBeLessThan(1);
		const scale = Number(await box.getAttribute("data-scale"));
		await expect
			.poll(async () => Math.abs((await boxHeight(box)) - 1240 * scale))
			.toBeLessThanOrEqual(1);

		await clickTranscriptControl(preview.getByTestId("tool-visualize-fullscreen"));
		const dialog = app.getByTestId("tool-visualize-fullscreen-dialog");
		await expect(dialog.getByTestId("html-view")).toHaveAttribute("data-html-mode", "themed");
		await expect(dialog.getByTestId("resource-preview")).not.toHaveAttribute(
			"data-natural-height",
			"true",
		);
		await expect(dialog.frameLocator("iframe").locator("#swatch")).toBeVisible();
		await app.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
	} finally {
		cleanup();
	}
});

test("an edited mockup keeps its card fitted while the new document loads", async ({
	page: app,
}) => {
	const cleanup = writeMockups({ "edited.html": sizedMockup(300) });
	try {
		const card = await openVisualization(app, "edited mockup", {
			type: "file",
			path: `${MOCKUP_DIR}/edited.html`,
		});
		const preview = card.getByTestId("resource-preview");
		const box = preview.getByTestId("html-frame-box");
		await expect(box).toHaveAttribute("data-content-height", "300");
		await expect(preview).toHaveAttribute("data-natural-height", "true");
		await preview.evaluate((node) => {
			const regained: (string | null)[] = [];
			Reflect.set(window, "__regainedHeight", regained);
			new MutationObserver((records) => {
				for (const record of records) {
					if (record.oldValue === null) regained.push(record.attributeName);
				}
			}).observe(node, {
				subtree: true,
				attributeOldValue: true,
				attributeFilter: ["data-natural-height", "data-content-height"],
			});
		});
		for (let edit = 1; edit <= EDITS; edit += 1) {
			const height = 300 + edit * 20;
			writeFileSync(join(E2E_FIXTURE_REPO, MOCKUP_DIR, "edited.html"), sizedMockup(height));
			await expect(box).toHaveAttribute("data-content-height", String(height), {
				timeout: 15_000,
			});
		}
		expect(await app.evaluate(() => Reflect.get(window, "__regainedHeight"))).toEqual([]);
	} finally {
		cleanup();
	}
});

test("a mockup taller than the limit keeps a 1600px card and scrolls inside", async ({
	page: app,
}) => {
	const cleanup = writeMockups({
		"long.html": page(
			'<details><summary>More</summary><div id="more"></div></details><div id="block"></div>',
			"html { scroll-behavior: smooth; } #block { height: 5000px; } #more { height: 40px; }",
		),
	});
	try {
		const card = await openVisualization(app, "long mockup", {
			type: "file",
			path: `${MOCKUP_DIR}/long.html`,
		});
		const preview = card.getByTestId("resource-preview");
		const box = preview.getByTestId("html-frame-box");
		await expect(box).toHaveAttribute("data-content-height", "1600");
		await expect.poll(() => boxHeight(box)).toBe(1600);

		const offsets = await preview.locator("iframe").evaluate(async (frame) => {
			const document = (frame as HTMLIFrameElement).contentDocument;
			const root = document?.documentElement;
			const details = document?.querySelector("details");
			if (!root || !details) throw new Error("no frame document");
			root.scrollTo({ top: 900, behavior: "instant" });
			await new Promise(requestAnimationFrame);
			details.open = true;
			const seen: number[] = [];
			for (let index = 0; index < 30; index += 1) {
				await new Promise(requestAnimationFrame);
				seen.push(root.scrollTop);
			}
			return seen;
		});
		expect(Math.min(...offsets)).toBeGreaterThanOrEqual(900);
	} finally {
		cleanup();
	}
});

test("a mockup card that scrolls back into a long chat does not move the rows around it", async ({
	page: app,
}) => {
	const cleanup = writeMockups({ "scrolled.html": sizedMockup(1600) });
	try {
		const { card } = await openVisualizationChat(
			app,
			"scrolled mockup",
			{ type: "file", path: `${MOCKUP_DIR}/scrolled.html` },
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
	} finally {
		cleanup();
	}
});

const outOfFlow = {
	"absolutely positioned boxes": {
		body: '<div class="layer" id="first"></div><div class="layer" id="lowest"></div>',
		style:
			".layer { position: absolute; left: 20px; width: 200px; height: 82px; } #first { top: 20px; } #lowest { top: 520px; }",
		height: 602,
		lowest: "#lowest",
	},
	"a fixed dialog over a body with a pixel min-height": {
		body: '<div id="backdrop"><div id="dialog"></div></div>',
		style:
			"body { min-height: 420px; } #backdrop { position: fixed; inset: 0; display: grid; place-items: center; } #dialog { width: 300px; height: 380px; }",
		height: 420,
		lowest: "#dialog",
	},
} as const;

for (const [name, mockup] of Object.entries(outOfFlow)) {
	test(`a mockup card holds content out of the normal flow: ${name}`, async ({ page: app }) => {
		const cleanup = writeMockups({ "layers.html": page(mockup.body, mockup.style) });
		try {
			const card = await openVisualization(app, `out of flow ${name}`, {
				type: "file",
				path: `${MOCKUP_DIR}/layers.html`,
			});
			const preview = card.getByTestId("resource-preview");
			const box = preview.getByTestId("html-frame-box");
			await expect(box).toHaveAttribute("data-content-height", String(mockup.height));
			await expect.poll(() => boxHeight(box)).toBe(mockup.height);
			const frame = await preview.locator("iframe").evaluate((element, selector) => {
				const root = (element as HTMLIFrameElement).contentDocument?.documentElement;
				const rect = root?.querySelector(selector)?.getBoundingClientRect();
				return root && rect
					? { top: rect.top, bottom: rect.bottom, visible: root.clientHeight }
					: null;
			}, mockup.lowest);
			expect(frame?.top).toBeGreaterThanOrEqual(0);
			expect(frame?.bottom).toBeLessThanOrEqual(frame?.visible ?? 0);
		} finally {
			cleanup();
		}
	});
}

for (const [name, style] of Object.entries(frameSized)) {
	test(`a mockup sized from its frame keeps the bounded card: ${name}`, async ({ page: app }) => {
		const cleanup = writeMockups({
			"framed.html": `<!doctype html><html><head><style>${style}</style></head><body><div id="block">frame sized</div></body></html>`,
		});
		try {
			const card = await openVisualization(app, `frame sized ${name}`, {
				type: "file",
				path: `${MOCKUP_DIR}/framed.html`,
			});
			const preview = card.getByTestId("resource-preview");
			await expect(preview.locator("iframe")).toHaveAttribute("sandbox", THEMED);
			await expect(preview.frameLocator("iframe").locator("#block")).toBeVisible();
			expect(await heightsOverFrames(preview)).toEqual([480]);
			await expect(preview).not.toHaveAttribute("data-natural-height", "true");
			await expect(preview.getByTestId("html-frame-box")).not.toHaveAttribute(
				"data-content-height",
			);
		} finally {
			cleanup();
		}
	});
}

test("a mockup whose height never stops changing is followed for a moment, then left alone", async ({
	page: app,
}) => {
	const cleanup = writeMockups({
		"pulse.html": page(
			'<div id="block"></div>',
			"#block { height: 100px; animation: pulse 400ms linear infinite alternate; } @keyframes pulse { to { height: 400px; } }",
		),
	});
	try {
		const card = await openVisualization(app, "pulsing mockup", {
			type: "file",
			path: `${MOCKUP_DIR}/pulse.html`,
		});
		const preview = card.getByTestId("resource-preview");
		const box = preview.getByTestId("html-frame-box");
		await expect(preview).toHaveAttribute("data-natural-height", "true");
		await expect.poll(async () => (await heightsOverFrames(box, 30)).length).toBe(1);
		expect(await boxHeight(box)).toBeGreaterThan(350);
		expect(await heightsOverFrames(box)).toHaveLength(1);
	} finally {
		cleanup();
	}
});

test("a mockup wider than the card leaves room for a space-taking scrollbar", async ({
	page: app,
	browserName,
}) => {
	test.skip(browserName !== "webkit", "headless Chromium draws overlay scrollbars only");
	const cleanup = writeMockups({
		"wide.html": page(
			'<div id="block"></div>',
			"::-webkit-scrollbar { width: 15px; height: 15px; } #block { width: 3000px; height: 300px; }",
		),
	});
	try {
		const card = await openVisualization(app, "wide mockup", {
			type: "file",
			path: `${MOCKUP_DIR}/wide.html`,
		});
		const preview = card.getByTestId("resource-preview");
		await expect(preview.getByTestId("html-frame-box")).toHaveAttribute(
			"data-content-height",
			"315",
		);
		const viewport = await preview.locator("iframe").evaluate((frame) => {
			const root = (frame as HTMLIFrameElement).contentDocument?.documentElement;
			return root ? { visible: root.clientHeight, content: root.scrollHeight } : null;
		});
		expect(viewport).toEqual({ visible: 300, content: 300 });
	} finally {
		cleanup();
	}
});

test("a mockup whose text would wrap under a vertical scrollbar still fits its card", async ({
	page: app,
}) => {
	const cleanup = writeMockups({ "wrap.html": sizedMockup(200) });
	try {
		const card = await openVisualization(app, "wrapping mockup", {
			type: "file",
			path: `${MOCKUP_DIR}/wrap.html`,
		});
		const preview = card.getByTestId("resource-preview");
		const box = preview.getByTestId("html-frame-box");
		await expect(box).toHaveAttribute("data-content-height", "200");
		const iframe = preview.locator("iframe");
		const width = await iframe.evaluate((frame) => (frame as HTMLIFrameElement).clientWidth);
		writeFileSync(
			join(E2E_FIXTURE_REPO, MOCKUP_DIR, "wrap.html"),
			page(
				'<div id="a" class="box"></div><div id="b" class="box"></div>',
				`body { display: flex; flex-wrap: wrap; } .box { flex: none; height: 200px; } #a { width: 50%; } #b { width: ${width / 2 - 2}px; }`,
			),
		);
		await expect(preview.frameLocator("iframe").locator("#b")).toBeAttached({ timeout: 15_000 });
		await expect(box).toHaveAttribute("data-content-height", "200");
		await expect(preview).toHaveAttribute("data-natural-height", "true");
		const layout = await iframe.evaluate((frame) => {
			const document = (frame as HTMLIFrameElement).contentDocument;
			return {
				visible: document?.documentElement.clientWidth,
				secondBoxTop: document?.querySelector("#b")?.getBoundingClientRect().top,
			};
		});
		expect(layout).toEqual({ visible: width, secondBoxTop: 0 });
	} finally {
		cleanup();
	}
});

test("a mockup follows a theme switch live without reloading its frame", async ({ page: app }) => {
	const cleanup = writeMockups({ "theme.html": themedMockup });
	try {
		const card = await openVisualization(app, "themed mockup", {
			type: "file",
			path: `${MOCKUP_DIR}/theme.html`,
		});
		const preview = card.getByTestId("resource-preview");
		const iframe = preview.locator("iframe");
		const swatch = () => frameStyle(iframe, "#swatch", "background-color");
		const before = await hostColor(app, "--container-elevated-bg");
		await expect.poll(swatch).toBe(before);
		expect(await iframe.getAttribute("srcdoc")).not.toContain("thinkrail-theme.css");

		await clickInTranscriptFrame(preview.frameLocator("iframe").locator("summary"));
		await expect(preview.getByTestId("html-frame-box")).toHaveAttribute(
			"data-content-height",
			"1240",
		);
		const loaded = await iframe.evaluateHandle(
			(frame) => (frame as HTMLIFrameElement).contentDocument,
		);

		const { current, opposite } = await oppositeTheme(app);
		try {
			await pickTheme(app, opposite);
			const after = await hostColor(app, "--container-elevated-bg");
			expect(after).not.toBe(before);
			await expect.poll(swatch).toBe(after);
			expect(
				await iframe.evaluate(
					(frame, document) => (frame as HTMLIFrameElement).contentDocument === document,
					loaded,
				),
			).toBe(true);
			await expect(preview.frameLocator("iframe").locator("details")).toHaveAttribute("open", "");
		} finally {
			await pickTheme(app, current);
		}
	} finally {
		cleanup();
	}
});

test("a before/after mockup comparison sizes both sides to the taller document", async ({
	page: app,
}) => {
	const cleanup = writeMockups({ "old.html": sizedMockup(300), "new.html": sizedMockup(700) });
	try {
		const card = await openVisualization(app, "mockup comparison", {
			type: "file",
			path: `${MOCKUP_DIR}/new.html`,
			before: `${MOCKUP_DIR}/old.html`,
		});
		const preview = card.getByTestId("resource-preview-diff");
		await expect(preview.getByTestId("html-diff-view")).toHaveAttribute("data-fit", "true");
		await expect(preview).toHaveAttribute("data-natural-height", "true");
		const boxes = preview.getByTestId("html-frame-box");
		await expect(boxes).toHaveCount(2);
		for (const box of await boxes.all()) {
			await expect(box).toHaveAttribute("data-content-height", "700");
			await expect.poll(() => boxHeight(box)).toBe(700);
		}
		expect((await preview.boundingBox())?.height ?? 0).toBeGreaterThan(700);
	} finally {
		cleanup();
	}
});

test("a comparison with a frame-sized side keeps the bounded box", async ({ page: app }) => {
	const cleanup = writeMockups({
		"old.html": sizedMockup(300),
		"new.html": page('<div id="block"></div>', "body { min-height: 100vh; padding: 24px; }"),
	});
	try {
		const card = await openVisualization(app, "frame sized comparison", {
			type: "file",
			path: `${MOCKUP_DIR}/new.html`,
			before: `${MOCKUP_DIR}/old.html`,
		});
		const preview = card.getByTestId("resource-preview-diff");
		const boxes = preview.getByTestId("html-frame-box");
		await expect(boxes).toHaveCount(2);
		for (const frame of await preview.locator("iframe").all()) {
			await expect(frame).toHaveAttribute("sandbox", THEMED);
			await expect(frame.contentFrame().locator("#block")).toBeAttached();
		}
		expect(await heightsOverFrames(preview)).toEqual([480]);
		await expect(preview.getByTestId("html-diff-view")).toHaveAttribute("data-fit", "false");
		await expect(preview).not.toHaveAttribute("data-natural-height", "true");
	} finally {
		cleanup();
	}
});

for (const [name, path] of [
	["outside the mockup directory", "static-page.html"],
	["reached through a mockup-dir dot-dot path", `${MOCKUP_DIR}/../../../static-page.html`],
] as const) {
	test(`a repository HTML file ${name} stays static and unthemed`, async ({ page: app }) => {
		writeFileSync(join(E2E_FIXTURE_REPO, "static-page.html"), page('<p id="out">static text</p>'));
		try {
			const card = await openVisualization(app, `repo html ${name}`, { type: "file", path });
			const preview = card.getByTestId("resource-preview");
			await expect(preview.getByTestId("html-view")).toHaveAttribute("data-html-mode", "static");
			const iframe = preview.locator("iframe");
			await expect(iframe).toHaveAttribute("sandbox", "");
			expect(await iframe.getAttribute("srcdoc")).not.toContain("data-thinkrail-theme");
			await expect(preview.frameLocator("iframe").getByText("static text")).toBeVisible();
			await expect(preview.getByTestId("html-frame-box")).toHaveAttribute(
				"data-viewport",
				"desktop",
			);
			await expect(preview).not.toHaveAttribute("data-natural-height", "true");
		} finally {
			rmSync(join(E2E_FIXTURE_REPO, "static-page.html"), { force: true });
		}
	});
}

test("an author rule inside a cascade layer outranks the theme", async ({ page: app }) => {
	const cleanup = writeMockups({
		"layered.html": page(
			'<p id="mark">layered</p>',
			"@layer base { :root { --text-default: rgb(7, 8, 9); } html { background: rgb(1, 2, 3); font-size: 16px; } #mark { color: var(--text-default); } }",
		),
	});
	try {
		const card = await openVisualization(app, "layered mockup", {
			type: "file",
			path: `${MOCKUP_DIR}/layered.html`,
		});
		const iframe = card.getByTestId("resource-preview").locator("iframe");
		await expect(iframe.contentFrame().locator("#mark")).toHaveText("layered");
		expect(await iframe.getAttribute("srcdoc")).toContain(
			'<style data-thinkrail-theme="">@layer thinkrail-theme{:root{',
		);
		expect(await frameStyle(iframe, "html", "background-color")).toBe("rgb(1, 2, 3)");
		expect(await frameStyle(iframe, "html", "font-size")).toBe("16px");
		expect(await frameStyle(iframe, "#mark", "color")).toBe("rgb(7, 8, 9)");
		expect(await hostColor(app, "--text-default")).not.toBe("rgb(7, 8, 9)");
	} finally {
		cleanup();
	}
});

test("a mockup frame that left for a blank document keeps its card height", async ({
	page: app,
}) => {
	const cleanup = writeMockups({ "left.html": sizedMockup(300) });
	try {
		const card = await openVisualization(app, "blank mockup", {
			type: "file",
			path: `${MOCKUP_DIR}/left.html`,
		});
		const preview = card.getByTestId("resource-preview");
		const box = preview.getByTestId("html-frame-box");
		await expect(box).toHaveAttribute("data-content-height", "300");
		const iframe = preview.locator("iframe");
		await iframe.evaluate((frame) => {
			const view = (frame as HTMLIFrameElement).contentWindow;
			if (view) view.location.href = "about:blank";
		});
		await expect
			.poll(() =>
				iframe.evaluate((frame) => {
					const document = (frame as HTMLIFrameElement).contentDocument;
					return document?.URL === "about:blank" && document.readyState === "complete";
				}),
			)
			.toBe(true);
		expect(Math.min(...(await heightsOverFrames(box)))).toBeGreaterThanOrEqual(300);
		await expect(box).toHaveAttribute("data-content-height", "300");
	} finally {
		cleanup();
	}
});

test("no script runs in a mockup frame, whether the author wrote it or it was added later", async ({
	page: app,
}) => {
	const cleanup = writeMockups({
		"active.html": page(
			`<p id="out" onclick="this.textContent = 'handler ran'">static text</p><script>document.getElementById("out").textContent = "script ran";</script>`,
		),
	});
	try {
		const card = await openVisualization(app, "active mockup", {
			type: "file",
			path: `${MOCKUP_DIR}/active.html`,
		});
		const preview = card.getByTestId("resource-preview");
		const iframe = preview.locator("iframe");
		await expect(iframe).toHaveAttribute("sandbox", THEMED);
		const srcdoc = (await iframe.getAttribute("srcdoc")) ?? "";
		expect(srcdoc).not.toContain("<script");
		expect(srcdoc).not.toContain("onclick");
		const out = preview.frameLocator("iframe").locator("#out");
		await expect(out).toHaveText("static text");
		await clickInTranscriptFrame(out);
		await expect(out).toHaveText("static text");

		await iframe.evaluate((frame) => {
			const document = (frame as HTMLIFrameElement).contentDocument;
			if (!document) throw new Error("no frame document");
			const script = document.createElement("script");
			script.textContent = 'document.getElementById("out").textContent = "injected script ran";';
			document.body.append(script);
			document
				.getElementById("out")
				?.setAttribute("onclick", "this.textContent = 'injected handler ran'");
		});
		await clickInTranscriptFrame(out);
		await expect(out).toHaveText("static text");
	} finally {
		cleanup();
	}
});

test("markup that shadows document properties cannot remove a mockup's policy", async ({
	page: app,
}) => {
	const cleanup = writeMockups({
		"shadowing.html": `<!doctype html><html><head><style>html { --accent: rgb(1, 2, 3); } #mark { color: var(--accent); }</style></head><body>
<img name="head"><img name="createElement"><img name="documentElement">
<form name="documentElement"><input name="localName"><input name="remove"><p>inside the form</p></form>
<div><template shadowrootmode="open"><a href="https://attacker.invalid/">shadow link</a></template></div>
<p id="mark">kept</p></body></html>`,
	});
	try {
		const card = await openVisualization(app, "shadowing mockup", {
			type: "file",
			path: `${MOCKUP_DIR}/shadowing.html`,
		});
		const preview = card.getByTestId("resource-preview");
		const iframe = preview.locator("iframe");
		await expect(preview.frameLocator("iframe").locator("#mark")).toHaveText("kept");
		const srcdoc = (await iframe.getAttribute("srcdoc")) ?? "";
		expect(srcdoc).toMatch(
			/^<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';[^"]*"><style data-thinkrail-theme="">/,
		);
		expect(srcdoc.match(/Content-Security-Policy/g)).toHaveLength(1);
		expect(srcdoc).toContain("--accent:");
		for (const removed of ["<template", "shadow link", "<form", "inside the form"]) {
			expect(srcdoc).not.toContain(removed);
		}
		expect(await frameStyle(iframe, "#mark", "color")).toBe("rgb(1, 2, 3)");
		expect(await hostColor(app, "--accent")).not.toBe("rgb(1, 2, 3)");
		await expect(preview).toHaveAttribute("data-natural-height", "true");
	} finally {
		cleanup();
	}
});

const revived =
	'<img srcset="https://attacker.invalid/set.png 1x"><link rel="preload" as="image" imagesrcset="https://attacker.invalid/preload.png 1x"><meta http-equiv="refresh" content="0;url=https://attacker.invalid/"><a href="https://attacker.invalid/">link</a><button onclick="document.title = 1">button</button>';

for (const [name, path] of [
	["a mockup", `${MOCKUP_DIR}/reparsed.html`],
	["a repository HTML file", "reparsed-page.html"],
] as const) {
	test(`markup that only a second parse makes live leaves ${name} with the policy alone`, async ({
		page: app,
	}) => {
		const file = join(E2E_FIXTURE_REPO, path);
		const cleanup = writeMockups({});
		writeFileSync(file, `<p>Mockup</p><math><mtext><table><mglyph><style><br>${revived}`);
		const requests: string[] = [];
		app.on("request", (request) => {
			if (request.url().includes("attacker.invalid")) requests.push(request.url());
		});
		try {
			const card = await openVisualization(app, `reparsed ${name}`, { type: "file", path });
			const iframe = card.getByTestId("resource-preview").locator("iframe");
			const frame = iframe.contentFrame();
			await expect(frame.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1);
			await expect(
				frame.locator("link, [srcset], [imagesrcset], [href], [onclick], button, math"),
			).toHaveCount(0);
			await expect(frame.locator("body")).toBeEmpty();
			expect(await iframe.getAttribute("srcdoc")).not.toContain("attacker.invalid");
			expect(requests).toEqual([]);
		} finally {
			rmSync(file, { force: true });
			cleanup();
		}
	});
}

test("the app page refuses to load any URL in a frame", async ({ page: app }) => {
	await openAppFresh(app);
	const framed: string[] = [];
	app.on("request", (request) => {
		if (request.frame() !== app.mainFrame()) framed.push(request.url());
	});
	await app.evaluate(() => {
		const violations: string[] = [];
		Reflect.set(window, "__frameViolations", violations);
		document.addEventListener("securitypolicyviolation", (event) =>
			violations.push(event.effectiveDirective),
		);
		const direct = document.createElement("iframe");
		direct.src = "/health";
		const refreshed = document.createElement("iframe");
		refreshed.srcdoc = '<meta http-equiv="refresh" content="0;url=/health"><p>srcdoc</p>';
		document.body.append(direct, refreshed);
	});
	await expect
		.poll(() => app.evaluate(() => Reflect.get(window, "__frameViolations")))
		.toEqual(["frame-src", "frame-src"]);
	const origin = new URL(app.url()).origin;
	expect(app.frames().filter((frame) => frame.url().startsWith(origin))).toEqual([app.mainFrame()]);
	expect(framed).toEqual([]);
});
