import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type FrameLocator, type Locator, type Page, test } from "@playwright/test";
import { DESKTOP_SHELL_GLOBAL } from "@thinkrail/contracts";
import { clickInTranscriptFrame, clickTranscriptControl } from "./fixtures/chatScroll";
import { E2E_FIXTURE_REPO } from "./fixtures/paths";
import {
	boxHeight,
	expectRemountedCardKeepsRows,
	FRAME_SIZED_STYLES,
	heightsOverFrames,
	hostColor,
	installDesktopShellMarker,
	MOCKUP_DIR,
	openVisualization,
	oppositeTheme,
	pickTheme,
	writeMockups,
} from "./fixtures/visualize";

const READY_GRACE_MS = 2250;

const TICK = `<button id="tick" onclick="this.textContent = String(Number(this.textContent) + 1)">0</button>`;

const mockup = (body: string, head = "") =>
	`<!doctype html><html><head><link rel="stylesheet" href="thinkrail-theme.css"><style>body { margin: 0; } p, button { display: block; margin: 0; padding: 0; border: 0; height: 20px; overflow: hidden; } #swatch { height: 40px; background: var(--container-elevated-bg); }</style>${head}</head><body>${body}</body></html>`;

interface ShownMockup {
	view: Locator;
	iframe: Locator;
	frame: FrameLocator;
	box: Locator;
	stopped: Locator;
}

function shown(view: Locator): ShownMockup {
	return {
		view,
		iframe: view.locator("iframe"),
		frame: view.frameLocator("iframe"),
		box: view.getByTestId("html-frame-box"),
		stopped: view.getByTestId("html-mockup-stopped"),
	};
}

async function showMockup(
	app: Page,
	name: string,
	html: string,
): Promise<ShownMockup & { preview: Locator }> {
	writeMockups({ "chart.html": html });
	const card = await openVisualization(app, name, {
		type: "file",
		path: `${MOCKUP_DIR}/chart.html`,
	});
	const preview = card.getByTestId("resource-preview");
	return { preview, ...shown(preview.getByTestId("html-view")) };
}

test.afterEach(() =>
	rmSync(join(E2E_FIXTURE_REPO, ".thinkrail"), { recursive: true, force: true }),
);

async function watchFrameSrcViolations(app: Page): Promise<() => Promise<number>> {
	await app.addInitScript(() => {
		let blocked = 0;
		Reflect.set(window, "__blockedFrameLoads", () => blocked);
		document.addEventListener("securitypolicyviolation", (event) => {
			if (event.effectiveDirective === "frame-src") blocked += 1;
		});
	});
	return () => app.evaluate(() => (Reflect.get(window, "__blockedFrameLoads") as () => number)());
}

function watchFramedResponses(app: Page): string[] {
	const framed: string[] = [];
	app.on("response", (response) => {
		if (response.frame() !== app.mainFrame()) framed.push(response.url());
	});
	return framed;
}

function expectNoFrameOnAppOrigin(app: Page, framed: readonly string[]): void {
	const origin = new URL(app.url()).origin;
	expect(framed.filter((url) => url.startsWith(origin))).toEqual([]);
	expect(app.frames().filter((frame) => frame.url().startsWith(origin))).toEqual([app.mainFrame()]);
}

async function expectStillRunning(app: Page, mockup: ShownMockup): Promise<void> {
	await app.waitForTimeout(READY_GRACE_MS + 500);
	await expect(mockup.stopped).toHaveCount(0);
	const tick = mockup.frame.locator("#tick");
	const before = Number(await tick.textContent());
	await clickInTranscriptFrame(tick);
	await expect(tick).toHaveText(String(before + 1));
}

const frameHeight = (frame: FrameLocator) =>
	frame.locator("html").evaluate((root) => Math.ceil(root.getBoundingClientRect().height));

test("a shown mockup runs its scripts and the card follows the content height", async ({
	page: app,
}) => {
	const mockupView = await showMockup(
		app,
		"scripted mockup",
		mockup(
			`<div id="block" style="height: 300px"></div><p id="out">static</p><button id="grow" onclick="document.getElementById('block').style.height = '700px'">Grow</button><script>document.getElementById("out").textContent = "script ran";</script>`,
		),
	);
	const { preview, view, iframe, frame, box } = mockupView;
	await expect(view).toHaveAttribute("data-html-mode", "scripted");
	await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
	await expect(preview.getByTestId("html-scripted-notice")).toContainText(
		"fetch, XHR and WebSocket are blocked",
	);
	await expect(preview.getByTestId("html-disabled-notice")).toHaveCount(0);
	await expect(frame.locator("#out")).toHaveText("script ran");
	expect(await iframe.getAttribute("srcdoc")).toContain(
		'<link rel="stylesheet" href="thinkrail-theme.css">',
	);

	await expect(box).toHaveAttribute("data-content-height", "340");
	expect(await frameHeight(frame)).toBe(340);
	await expect(preview).toHaveAttribute("data-natural-height", "true");
	await expect(box).toHaveAttribute("data-viewport", "responsive");
	await expect.poll(() => boxHeight(box)).toBe(340);

	await clickInTranscriptFrame(frame.locator("#grow"));
	await expect(box).toHaveAttribute("data-content-height", "740");
	await expect.poll(() => boxHeight(box)).toBe(740);
	await expect(mockupView.stopped).toHaveCount(0);
});

const PROBE_HEIGHT = 8192;

const TALLEST_VIEWPORT = `<script>addEventListener("resize", () => { document.documentElement.dataset.tallest = String(Math.max(Number(document.documentElement.dataset.tallest ?? 0), innerHeight)); });</script>`;

const tallestViewport = (frame: FrameLocator) =>
	frame.locator("html").evaluate((root) => Number(root.dataset.tallest ?? 0));

function restsForFrames(iframe: Locator, frames = 60): Promise<boolean> {
	return iframe.evaluate(async (element, count) => {
		for (let frame = 0; frame < count; frame += 1) {
			if ((element as HTMLElement).style.height !== "") return false;
			await new Promise(requestAnimationFrame);
		}
		return true;
	}, frames);
}

for (const [name, style] of Object.entries(FRAME_SIZED_STYLES)) {
	test(`a scripted mockup sized from its frame keeps the bounded card: ${name}`, async ({
		page: app,
	}) => {
		const { preview, iframe, frame, box } = await showMockup(
			app,
			`frame sized script ${name}`,
			`<!doctype html><html><head><style>${style}</style>${TALLEST_VIEWPORT}</head><body><div id="block">frame sized</div></body></html>`,
		);
		await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
		await expect(frame.locator("#block")).toBeVisible();
		expect(await heightsOverFrames(preview, 120)).toEqual([480]);
		await expect.poll(() => tallestViewport(frame)).toBeGreaterThanOrEqual(PROBE_HEIGHT);
		await expect.poll(() => restsForFrames(iframe)).toBe(true);
		await expect(preview).not.toHaveAttribute("data-natural-height", "true");
		await expect(box).not.toHaveAttribute("data-content-height");
		expect(await boxHeight(preview)).toBe(480);
	});
}

test("a scripted mockup that keeps growing is followed for a moment, then left alone", async ({
	page: app,
}) => {
	const { preview, iframe, frame, box } = await showMockup(
		app,
		"growing mockup",
		mockup(
			`<div id="block" style="height: 100px"></div><script>let height = 100; setInterval(() => { height += 10; document.getElementById("block").style.height = height + "px"; }, 150);</script>`,
		),
	);
	await expect(preview).toHaveAttribute("data-natural-height", "true");
	await expect
		.poll(async () => (await heightsOverFrames(box, 30)).length, { timeout: 15_000 })
		.toBe(1);
	const settled = await boxHeight(box);
	expect(settled).toBeGreaterThan(150);
	await expect.poll(() => frameHeight(frame)).toBeGreaterThan(settled + 100);
	expect(await heightsOverFrames(box)).toHaveLength(1);
	expect(await restsForFrames(iframe)).toBe(true);
	await expect(preview).toHaveAttribute("data-natural-height", "true");
});

test("a scripted mockup whose height changes in every frame keeps the bounded card", async ({
	page: app,
}) => {
	const { preview, iframe, frame, box } = await showMockup(
		app,
		"pulsing script mockup",
		mockup(
			`<div id="block"></div>`,
			`<style>#block { height: 100px; animation: pulse 400ms linear infinite alternate; } @keyframes pulse { to { height: 400px; } }</style>${TALLEST_VIEWPORT}`,
		),
	);
	await expect.poll(() => tallestViewport(frame)).toBeGreaterThanOrEqual(PROBE_HEIGHT);
	await expect.poll(() => restsForFrames(iframe), { timeout: 15_000 }).toBe(true);
	expect(await heightsOverFrames(preview)).toEqual([480]);
	await expect(preview).not.toHaveAttribute("data-natural-height", "true");
	await expect(box).not.toHaveAttribute("data-content-height");
});

test("an edited scripted mockup keeps its card fitted while the new document loads", async ({
	page: app,
}) => {
	const sized = (height: number) =>
		mockup(
			`<div id="block"></div><script>document.getElementById("block").style.height = "${height}px";</script>`,
		);
	const { preview, box } = await showMockup(app, "edited script mockup", sized(300));
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
	for (let edit = 1; edit <= 10; edit += 1) {
		const height = 300 + edit * 20;
		writeFileSync(join(E2E_FIXTURE_REPO, MOCKUP_DIR, "chart.html"), sized(height));
		await expect(box).toHaveAttribute("data-content-height", String(height), {
			timeout: 15_000,
		});
	}
	expect(await app.evaluate(() => Reflect.get(window, "__regainedHeight"))).toEqual([]);
});

test("a scripted mockup card that scrolls back into a long chat does not move the rows around it", async ({
	page: app,
}) => {
	writeMockups({
		"chart.html": mockup(
			`<div id="block"></div><script>document.getElementById("block").style.height = "1600px";</script>`,
		),
	});
	await expectRemountedCardKeepsRows(app, "scrolled script mockup", "chart.html");
});

test("a scripted mockup taller than the limit keeps a 1600px card and its scroll offset", async ({
	page: app,
}) => {
	const { frame, iframe, box } = await showMockup(
		app,
		"long script mockup",
		mockup(
			`<details><summary>More</summary><div style="height: 40px"></div></details><div style="height: 5000px"></div>`,
			`<style>html { scroll-behavior: smooth; }</style>${TALLEST_VIEWPORT}`,
		),
	);
	await expect(box).toHaveAttribute("data-content-height", "1600");
	await expect.poll(() => boxHeight(box)).toBe(1600);
	const root = frame.locator("html");
	await expect.poll(() => root.evaluate((element) => element.clientHeight)).toBe(1600);
	await root.evaluate((element) => {
		element.scrollTo({ top: 900, behavior: "instant" });
		element.dataset.tallest = "0";
	});
	await frame.locator("details").evaluate((details) => {
		(details as HTMLDetailsElement).open = true;
	});
	await expect.poll(() => tallestViewport(frame)).toBeGreaterThanOrEqual(PROBE_HEIGHT);
	await expect.poll(() => restsForFrames(iframe)).toBe(true);
	expect(await root.evaluate((element) => element.scrollTop)).toBeGreaterThanOrEqual(900);
	await expect(box).toHaveAttribute("data-content-height", "1600");
});

test("an author rule in a scripted mockup outranks the theme, layered or not", async ({
	page: app,
}) => {
	const { frame, iframe } = await showMockup(
		app,
		"layered script mockup",
		mockup(
			`<p id="mark">layered</p><p id="plain">plain</p>`,
			"<style>@layer base { :root { --text-default: rgb(7, 8, 9); } html { background: rgb(1, 2, 3); font-size: 16px; } #mark { color: var(--text-default); } } #plain { color: var(--container-elevated-bg); }</style>",
		),
	);
	await expect(frame.locator("#mark")).toHaveText("layered");
	expect(await iframe.getAttribute("srcdoc")).toContain(
		"<style data-thinkrail-theme>@layer thinkrail-theme{:root{",
	);
	await expect(frame.locator("html")).toHaveCSS("background-color", "rgb(1, 2, 3)");
	await expect(frame.locator("html")).toHaveCSS("font-size", "16px");
	await expect(frame.locator("#mark")).toHaveCSS("color", "rgb(7, 8, 9)");
	await expect(frame.locator("#plain")).toHaveCSS(
		"color",
		await hostColor(app, "--container-elevated-bg"),
	);
	expect(await hostColor(app, "--text-default")).not.toBe("rgb(7, 8, 9)");
});

test("a theme switch reaches a running mockup without reloading it", async ({ page: app }) => {
	const { frame, iframe } = await showMockup(
		app,
		"live theme mockup",
		mockup(
			`<div id="swatch"></div>${TICK}<p id="events">0</p><script>let events = 0; addEventListener("thinkrail:themechange", () => { events += 1; document.getElementById("events").textContent = events + " " + getComputedStyle(document.getElementById("swatch")).backgroundColor; });</script>`,
		),
	);
	const swatch = () =>
		frame.locator("#swatch").evaluate((element) => getComputedStyle(element).backgroundColor);
	const before = await hostColor(app, "--container-elevated-bg");
	await expect.poll(swatch).toBe(before);
	await clickInTranscriptFrame(frame.locator("#tick"));
	await clickInTranscriptFrame(frame.locator("#tick"));
	await expect(frame.locator("#tick")).toHaveText("2");
	const srcdoc = await iframe.getAttribute("srcdoc");

	const { current, opposite } = await oppositeTheme(app);
	try {
		await pickTheme(app, opposite);
		const after = await hostColor(app, "--container-elevated-bg");
		expect(after).not.toBe(before);
		await expect.poll(swatch).toBe(after);
		await expect
			.poll(async () => (await frame.locator("#events").textContent())?.endsWith(` ${after}`))
			.toBe(true);
		await expect(frame.locator("#tick")).toHaveText("2");
		expect(await iframe.getAttribute("srcdoc")).toBe(srcdoc);
	} finally {
		await pickTheme(app, current);
	}
});

test("a mockup loads libraries only from the listed CDN prefixes", async ({ page: app }) => {
	const routed: string[] = [];
	await app.context().route(/^https:/, (route) => {
		const url = route.request().url();
		routed.push(url);
		if (url.endsWith(".css")) {
			return route.fulfill({ contentType: "text/css", body: "#styled { color: rgb(1, 2, 3); }" });
		}
		const name = new URL(url).hostname;
		return route.fulfill({
			contentType: "text/javascript",
			body: `document.getElementById("libs").textContent += " ${name}";`,
		});
	});
	const framed = watchFramedResponses(app);
	const allowed = [
		"https://cdn.jsdelivr.net/npm/demo@1.0.0/dist/demo.js",
		"https://unpkg.com/demo@1.0.0/dist/demo.js",
		"https://cdnjs.cloudflare.com/ajax/libs/demo/1.0.0/demo.min.js",
	];
	const refused = [
		"https://cdn.jsdelivr.net/gh/someone/repo@main/demo.js",
		"https://cdn.jsdelivr.net/npm/../gh/someone/repo/demo.js",
		"https://cdnjs.cloudflare.com/other/demo.js",
		"https://example.com/demo.js",
		"/health?as=script",
	];
	const scripts = [...allowed, ...refused].map((src) => `<script src="${src}"></script>`).join("");
	const { frame } = await showMockup(
		app,
		"cdn mockup",
		mockup(
			`<p id="libs">ran:</p><p id="styled">styled</p>${scripts}<img src="/health?as=image" alt=""><img src="https://example.com/pixel.png" alt=""><script>addEventListener("load", () => { document.getElementById("libs").dataset.done = "true"; });</script>`,
			'<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/demo@1.0.0/dist/demo.css">',
		),
	);
	await expect(frame.locator("#libs")).toHaveAttribute("data-done", "true");
	await expect(frame.locator("#libs")).toHaveText(
		"ran: cdn.jsdelivr.net unpkg.com cdnjs.cloudflare.com",
	);
	expect(
		await frame.locator("#styled").evaluate((element) => getComputedStyle(element).color),
	).toBe("rgb(1, 2, 3)");
	expect(routed.sort()).toEqual(
		[...allowed, "https://cdn.jsdelivr.net/npm/demo@1.0.0/dist/demo.css"].sort(),
	);
	expectNoFrameOnAppOrigin(app, framed);
});

test("a mockup script cannot reach the host by fetch, XHR or WebSocket", async ({ page: app }) => {
	const framed = watchFramedResponses(app);
	const { frame } = await showMockup(
		app,
		"network mockup",
		mockup(
			`<p id="fetch">pending</p><p id="xhr">pending</p><p id="ws">pending</p><p id="base"></p><script>
const set = (id, text) => { document.getElementById(id).textContent = text; };
set("base", new URL("/health", document.baseURI).href);
fetch("/health").then(() => set("fetch", "reached"), () => set("fetch", "blocked"));
try {
	const xhr = new XMLHttpRequest();
	xhr.onload = () => set("xhr", "reached");
	xhr.onerror = () => set("xhr", "blocked");
	xhr.open("GET", "/health");
	xhr.send();
} catch { set("xhr", "blocked"); }
try {
	const socket = new WebSocket(new URL("/ws", document.baseURI).href.replace(/^http/, "ws"));
	socket.onopen = () => set("ws", "reached");
	socket.onerror = () => set("ws", "blocked");
} catch { set("ws", "blocked"); }
</script>`,
		),
	);
	const origin = new URL(app.url()).origin;
	await expect(frame.locator("#base")).toHaveText(`${origin}/health`);
	for (const id of ["fetch", "xhr", "ws"])
		await expect(frame.locator(`#${id}`)).toHaveText("blocked");
	expect(await app.evaluate(() => fetch("/health").then((response) => response.ok))).toBe(true);
	expectNoFrameOnAppOrigin(app, framed);
});

test("a click on a link in a mockup does not navigate the frame", async ({ page: app }) => {
	const blockedLoads = await watchFrameSrcViolations(app);
	const framed = watchFramedResponses(app);
	const mockupView = await showMockup(
		app,
		"links mockup",
		mockup(
			`${TICK}<a id="fragment" href="#bottom">fragment</a> <a id="empty" href="">empty</a> <a id="external" href="https://example.com/">external</a> <a id="relative" href="page.html">relative</a><p id="made"></p><p id="clicks">0</p><p id="bottom">bottom</p><script>
document.getElementById("made").innerHTML = '<a id="dynamic" href="#" onclick="document.getElementById(\\'clicks\\').textContent = \\'handler ran\\'">dynamic</a>';
</script>`,
		),
	);
	const { frame } = mockupView;
	for (const id of ["fragment", "empty", "external", "relative", "dynamic"]) {
		await clickInTranscriptFrame(frame.locator(`#${id}`));
	}
	await expect(frame.locator("#clicks")).toHaveText("handler ran");
	await expectStillRunning(app, mockupView);
	expect(await blockedLoads()).toBe(0);
	expectNoFrameOnAppOrigin(app, framed);
});

const NAVIGATIONS: Record<string, { html: string; click: boolean }> = {
	"location.href": {
		html: mockup(`${TICK}<button id="go" onclick="location.href = '/health?left'">Go</button>`),
		click: true,
	},
	"location.replace": {
		html: mockup(`${TICK}<button id="go" onclick="location.replace('/health?left')">Go</button>`),
		click: true,
	},
	"a meta refresh": {
		html: mockup(TICK, '<meta http-equiv="refresh" content="0;url=/health?left">'),
		click: false,
	},
	"location.href before the load ends": {
		html: mockup(`${TICK}<script>location.href = "/health?left";</script>`),
		click: false,
	},
};

for (const [name, { html, click }] of Object.entries(NAVIGATIONS)) {
	test(`a mockup that leaves through ${name} loads no page`, async ({ page: app, browserName }) => {
		const blockedLoads = await watchFrameSrcViolations(app);
		const framed = watchFramedResponses(app);
		const mockupView = await showMockup(app, `navigation ${name}`, html);
		if (click) await clickInTranscriptFrame(mockupView.frame.locator("#go"));
		await expect.poll(blockedLoads).toBeGreaterThan(0);
		if (browserName === "chromium") {
			await expect(mockupView.stopped).toContainText("tried to open another page", {
				timeout: 10_000,
			});
			await expect(mockupView.iframe).toHaveCount(0);
		} else {
			await expectStillRunning(app, mockupView);
		}
		expectNoFrameOnAppOrigin(app, framed);
	});
}

test("a mockup that blanks its own frame is closed with a notice", async ({ page: app }) => {
	const framed = watchFramedResponses(app);
	const { frame, stopped, iframe } = await showMockup(
		app,
		"blank mockup",
		mockup(`${TICK}<button id="go" onclick="location.href = 'about:blank'">Go</button>`),
	);
	await clickInTranscriptFrame(frame.locator("#go"));
	await expect(stopped).toContainText("stopped responding", { timeout: 10_000 });
	await expect(iframe).toHaveCount(0);
	expectNoFrameOnAppOrigin(app, framed);

	writeMockups({ "chart.html": mockup(`${TICK}<p id="fixed">fixed</p>`) });
	await expect(frame.locator("#fixed")).toHaveText("fixed");
	await expect(stopped).toHaveCount(0);
	await clickInTranscriptFrame(frame.locator("#tick"));
	await expect(frame.locator("#tick")).toHaveText("1");
});

const FLOOD_BATCH = 20_000;

const FLOODING = mockup(
	`${TICK}<button id="some" onclick="post(parent, 500)">Some</button><button id="own" onclick="flood()">Own</button><button id="nested" onclick="nest()">Nested</button><script>
const post = (target, count) => { for (let i = 0; i < count; i += 1) target.postMessage("flood", "*"); };
const flood = () => { post(top, ${FLOOD_BATCH}); setTimeout(flood, 0); };
const nest = () => {
	const frame = document.createElement("iframe");
	frame.srcdoc = "<script>const post = " + post + "; const flood = " + flood + "; flood();<\\/script>";
	document.body.append(frame);
};
</script>`,
);

async function countFloodMessages(app: Page): Promise<() => Promise<number>> {
	await app.evaluate(() => {
		let received = 0;
		Reflect.set(window, "__floodMessages", () => received);
		window.addEventListener("message", (event) => {
			if (event.data === "flood") received += 1;
		});
	});
	return () => app.evaluate(() => (Reflect.get(window, "__floodMessages") as () => number)());
}

for (const [sender, button] of [
	["its own window", "#own"],
	["a nested frame", "#nested"],
] as const) {
	test(`a mockup that floods the app with messages from ${sender} is closed with a notice`, async ({
		page: app,
	}) => {
		const mockupView = await showMockup(app, `flood from ${sender}`, FLOODING);
		const { frame, stopped, iframe } = mockupView;
		await clickInTranscriptFrame(frame.locator("#some"));
		await expectStillRunning(app, mockupView);

		const received = await countFloodMessages(app);
		await clickInTranscriptFrame(frame.locator(button));
		await expect(stopped).toContainText("overloaded the app", { timeout: 10_000 });
		await expect(iframe).toHaveCount(0);
		await expect.poll(received).toBe(FLOOD_BATCH);
		await app.waitForTimeout(500);
		expect(await received()).toBe(FLOOD_BATCH);
	});

	test(`a flood from ${sender} of one mockup leaves the mockup next to it open`, async ({
		page: app,
	}) => {
		writeMockups({ "quiet.html": mockup(TICK), "loud.html": FLOODING });
		const card = await openVisualization(app, `flood from ${sender} beside a quiet mockup`, {
			type: "file",
			path: `${MOCKUP_DIR}/loud.html`,
			before: `${MOCKUP_DIR}/quiet.html`,
		});
		const preview = card.getByTestId("resource-preview-diff");
		const frames = preview.locator("iframe");
		await expect(frames).toHaveCount(2);
		await expect(frames.first()).toHaveAttribute("sandbox", "allow-scripts");
		await expect(frames.last()).toHaveAttribute("sandbox", "allow-scripts");
		const quiet = frames.first().contentFrame().locator("#tick");
		await expect(frames.first().contentFrame().locator("#own")).toHaveCount(0);

		await clickInTranscriptFrame(frames.last().contentFrame().locator(button));
		const stopped = preview.getByTestId("html-mockup-stopped");
		await expect(stopped).toContainText("overloaded the app", { timeout: 10_000 });
		await app.waitForTimeout(READY_GRACE_MS + 500);
		await expect(stopped).toHaveCount(1);
		await expect(frames).toHaveCount(1);
		await clickInTranscriptFrame(quiet);
		await expect(quiet).toHaveText("1");
	});
}

const FLOOD_OVER_LIMIT = 1500;

const CLOSES_ON_KEY = mockup(
	`<input id="field"><script>
document.getElementById("field").addEventListener("keydown", (event) => {
	if (event.key === "f") for (let i = 0; i < ${FLOOD_OVER_LIMIT}; i += 1) parent.postMessage("flood", "*");
	if (event.key === "b") location.href = "about:blank";
});
</script>`,
);

for (const [cause, key] of [
	["a message flood", "f"],
	["a dead document", "b"],
] as const) {
	test(`a mockup closed by ${cause} while it holds the keyboard focus hands the focus to its notice`, async ({
		page: app,
	}) => {
		const { frame, iframe, stopped } = await showMockup(app, `focus after ${cause}`, CLOSES_ON_KEY);
		await clickInTranscriptFrame(frame.locator("#field"));
		await expect(iframe).toBeFocused();
		await frame.locator("#field").press(key);
		await expect(stopped).toBeFocused({ timeout: 10_000 });
		await expect(iframe).toHaveCount(0);
	});
}

test("a mockup closed while the focus is elsewhere leaves the focus where it was", async ({
	page: app,
}) => {
	const { stopped, iframe } = await showMockup(
		app,
		"flood with no focus",
		mockup(
			`<p>chart</p><script>setTimeout(() => { for (let i = 0; i < ${FLOOD_OVER_LIMIT}; i += 1) parent.postMessage("flood", "*"); }, 1000);</script>`,
		),
	);
	await expect(stopped).toBeVisible({ timeout: 10_000 });
	await expect(iframe).toHaveCount(0);
	await expect(stopped).not.toBeFocused();
	await expect(stopped).not.toHaveAttribute("tabindex");
});

test("a mockup that sets its window name defines no global on the app page", async ({
	page: app,
}) => {
	const { view, frame } = await showMockup(
		app,
		"named mockup",
		mockup(
			`${TICK}<p id="out">static</p><script>window.name = "${DESKTOP_SHELL_GLOBAL}"; document.getElementById("out").textContent = "name: " + window.name;</script>`,
		),
	);
	await expect(frame.locator("#out")).toHaveText("name: ");
	await clickInTranscriptFrame(frame.locator("#tick"));
	await expect(frame.locator("#tick")).toHaveText("1");
	expect(await app.evaluate((name) => Reflect.has(window, name), DESKTOP_SHELL_GLOBAL)).toBe(false);
	await expect(view).toHaveAttribute("data-html-mode", "scripted");
});

test("a long task of the app after a mockup loads neither closes the mockup nor leaves it unmeasured", async ({
	page: app,
}) => {
	await app.addInitScript((stallMs) => {
		let stalled = false;
		document.addEventListener(
			"load",
			(event) => {
				const target = event.target;
				if (stalled || !(target instanceof HTMLIFrameElement)) return;
				if (target.getAttribute("sandbox") !== "allow-scripts") return;
				stalled = true;
				const channel = new MessageChannel();
				channel.port1.onmessage = () => {
					const until = performance.now() + stallMs;
					while (performance.now() < until);
					Reflect.set(window, "__appStalled", true);
				};
				channel.port2.postMessage(0);
			},
			true,
		);
	}, 2500);
	const mockupView = await showMockup(
		app,
		"mockup under a busy app",
		mockup(`<div style="height: 900px"></div>${TICK}`),
	);
	await expect
		.poll(() => app.evaluate(() => Reflect.get(window, "__appStalled")), { timeout: 15_000 })
		.toBe(true);
	await expect(mockupView.box).toHaveAttribute("data-content-height", "920");
	await expectStillRunning(app, mockupView);
});

test("a mockup that reloads itself or changes its fragment keeps running", async ({
	page: app,
}) => {
	const mockupView = await showMockup(
		app,
		"reloading mockup",
		mockup(
			`<div id="swatch"></div>${TICK}<p id="boot"></p><button id="reload" onclick="location.reload()">Reload</button><button id="hash" onclick="location.hash = 'x'">Hash</button><script>document.getElementById("boot").textContent = String(Math.random());</script>`,
		),
	);
	const { frame } = mockupView;
	const boot = frame.locator("#boot");
	await expect(boot).not.toHaveText("");
	const first = await boot.textContent();

	await clickInTranscriptFrame(frame.locator("#hash"));
	await expectStillRunning(app, mockupView);
	await expect(boot).toHaveText(first ?? "");

	await clickInTranscriptFrame(frame.locator("#reload"));
	await expect(boot).not.toHaveText(first ?? "");
	await expectStillRunning(app, mockupView);
	expect(
		await frame.locator("#swatch").evaluate((element) => getComputedStyle(element).backgroundColor),
	).toBe(await hostColor(app, "--container-elevated-bg"));
});

test("a mockup that replaces the globals the host script uses is still themed and sized", async ({
	page: app,
}) => {
	const { frame, box } = await showMockup(
		app,
		"shadowing mockup",
		mockup(
			`<div id="swatch"></div><div id="block" style="height: 260px"></div><p id="out">static</p><script>
const parent = 1; const addEventListener = 1; const dispatchEvent = 1; const postMessage = 1;
const Event = 1; const ResizeObserver = 1; const Math = 1; const getComputedStyle = 1;
</script><script>
for (const name of Object.getOwnPropertyNames(window)) {
	if (name === "location") continue;
	try { window[name] = 1; } catch {}
}
document.getElementById("out").textContent = "shadowed " + (typeof parent) + " " + (typeof window.ResizeObserver);
document.getElementById("out").onclick = () => { document.getElementById("block").style.height = "500px"; };
</script>`,
		),
	);
	await expect(frame.locator("#out")).toHaveText("shadowed number number");
	await expect(box).toHaveAttribute("data-content-height", "320");
	await clickInTranscriptFrame(frame.locator("#out"));
	await expect(box).toHaveAttribute("data-content-height", "560");

	const before = await hostColor(app, "--container-elevated-bg");
	const { current, opposite } = await oppositeTheme(app);
	try {
		await pickTheme(app, opposite);
		const after = await hostColor(app, "--container-elevated-bg");
		expect(after).not.toBe(before);
		await expect(frame.locator("#swatch")).toHaveCSS("background-color", after);
	} finally {
		await pickTheme(app, current);
	}
});

test("a mockup tab restored before its chat loads turns scripted when the chat arrives", async ({
	page: app,
}) => {
	let delayMessages = false;
	await app.routeWebSocket(/\/ws(\?|$)/, (browser) => {
		const server = browser.connectToServer();
		const delayed = new Set<string>();
		browser.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (delayMessages && frame.method === "session.getMessages") delayed.add(frame.id);
			server.send(message);
		});
		server.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (delayed.delete(frame.id)) setTimeout(() => browser.send(message), 3_000);
			else browser.send(message);
		});
	});
	const { preview } = await showMockup(
		app,
		"restored mockup",
		mockup(
			`<p id="out">static</p><script>document.getElementById("out").textContent = "script ran";</script>`,
		),
	);
	await clickTranscriptControl(preview.getByTestId("tool-visualize-open-tab"));
	const fileTab = app
		.locator('[data-testid="editor-tab"][data-kind="file"]')
		.filter({ hasText: "chart.html" });
	await expect(fileTab).toHaveAttribute("data-active", "true");
	const restored = app.getByTestId("html-view").filter({ visible: true });
	await expect(restored).toHaveAttribute("data-html-mode", "scripted");

	delayMessages = true;
	await app.reload();
	await fileTab.click();
	await expect(restored).toHaveAttribute("data-html-mode", "themed");
	await expect(restored.locator("iframe")).toHaveAttribute("sandbox", "allow-same-origin");
	await expect(restored.frameLocator("iframe").locator("#out")).toHaveText("static");

	await expect(restored).toHaveAttribute("data-html-mode", "scripted", { timeout: 10_000 });
	await expect(restored.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
	await expect(restored.frameLocator("iframe").locator("#out")).toHaveText("script ran");
});

const ACTIVE = `<p id="out" onclick="this.textContent = 'handler ran'">static</p><script>document.getElementById("out").textContent = "script ran";</script>`;

for (const [name, path] of [
	["outside the mockup directory", "static-page.html"],
	["reached through a mockup-dir dot-dot path", `${MOCKUP_DIR}/../../../static-page.html`],
] as const) {
	test(`a repository HTML file ${name} runs no script when a visualize call shows it`, async ({
		page: app,
	}) => {
		writeFileSync(join(E2E_FIXTURE_REPO, "static-page.html"), mockup(ACTIVE));
		try {
			const card = await openVisualization(app, `repo html ${name}`, { type: "file", path });
			const { view, iframe, frame } = shown(card.getByTestId("html-view"));
			await expect(view).toHaveAttribute("data-html-mode", "static");
			await expect(iframe).toHaveAttribute("sandbox", "");
			await expect(frame.locator("#out")).toHaveText("static");
			const srcdoc = (await iframe.getAttribute("srcdoc")) ?? "";
			for (const active of ["<script", "onclick"]) expect(srcdoc).not.toContain(active);
		} finally {
			rmSync(join(E2E_FIXTURE_REPO, "static-page.html"), { force: true });
		}
	});
}

test("a mockup that no visualize call showed runs no script", async ({ page: app }) => {
	writeMockups({ "unshown.html": mockup(ACTIVE), "chart.html": mockup(ACTIVE) });
	const card = await openVisualization(
		app,
		"unshown mockup",
		{ type: "file", path: `${MOCKUP_DIR}/chart.html` },
		`[Open the other mockup](${MOCKUP_DIR}/unshown.html)`,
	);
	await expect(card.getByTestId("html-view")).toHaveAttribute("data-html-mode", "scripted");
	await clickTranscriptControl(app.getByRole("button", { name: "Open the other mockup" }));
	const fileTab = app
		.locator('[data-testid="editor-tab"][data-kind="file"]')
		.filter({ hasText: "unshown.html" });
	await expect(fileTab).toHaveAttribute("data-active", "true");
	const { view, iframe, frame } = shown(app.getByTestId("html-view").filter({ visible: true }));
	await expect(view).toHaveAttribute("data-html-mode", "themed");
	await expect(iframe).toHaveAttribute("sandbox", "allow-same-origin");
	await frame.locator("#out").click();
	await expect(frame.locator("#out")).toHaveText("static");
});

test("the desktop shell shows a shown mockup themed, with its controls and noscript content", async ({
	page: app,
}) => {
	await installDesktopShellMarker(app);
	const { view, iframe, frame, preview } = await showMockup(
		app,
		"desktop mockup",
		mockup(
			`<button id="save" onclick="this.textContent = 'handler ran'">Save</button><input id="volume" type="range" min="0" max="10" value="3" autofocus><form><input id="in-form" value="dropped"></form><canvas id="chart"></canvas><noscript><p id="fallback">static chart</p></noscript><script>document.getElementById("save").textContent = "script ran";</script>`,
		),
	);
	await expect(view).toHaveAttribute("data-html-mode", "themed");
	await expect(iframe).toHaveAttribute("sandbox", "allow-same-origin");
	await expect(preview.getByTestId("html-disabled-notice")).toBeVisible();
	await expect(frame.locator("#save")).toBeVisible();
	await clickInTranscriptFrame(frame.locator("#save"));
	await expect(frame.locator("#save")).toHaveText("Save");
	await expect(frame.locator("#volume")).toBeVisible();
	await expect(frame.locator("#volume")).toHaveValue("3");
	await expect(frame.locator("#fallback")).toHaveText("static chart");
	await expect(frame.locator("#in-form")).toHaveCount(0);
	expect(await iframe.getAttribute("srcdoc")).not.toContain("autofocus");
});
