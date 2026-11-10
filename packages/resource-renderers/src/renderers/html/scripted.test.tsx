import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { MOCKUP_CDN_SOURCES } from "@thinkrail/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import {
	ResourceEnvironmentProvider,
	type ResourceHost,
	ResourceHostProvider,
	type ResourceHtmlMode,
} from "../../host";
import { describeResource, PENDING_TEXT_META } from "../../registry";
import { installFakeDocument, parseFakeMarkup } from "../../testing/fakeDocument";
import { acceptFrameMessage, FRAME_BOOTSTRAP, themeMessage } from "./frameMessages";
import { createFrameWatch, FRAME_WATCH, frameSender } from "./frameWatch";
import { themeCss } from "./hostTheme";
import { MockupStoppedNotice } from "./ScriptedHtmlFrame";
import { buildScriptedHtmlDocument, SCRIPTED_HTML_CSP } from "./scriptedDocument";
import HtmlView from "./View";
import { clampContentHeight, HTML_CONTENT_HEIGHT } from "./viewport";

const CDN =
	"https://cdn.jsdelivr.net/npm/ https://unpkg.com https://cdnjs.cloudflare.com/ajax/libs/";

test("the scripted CSP is exact and lists the CDN constant", () => {
	expect(MOCKUP_CDN_SOURCES.join(" ")).toBe(CDN);
	expect(SCRIPTED_HTML_CSP).toBe(
		`default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' ${CDN}; style-src 'unsafe-inline' ${CDN}; img-src data: blob: ${CDN}; font-src data: ${CDN}; connect-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'`,
	);
	for (const open of ["'unsafe-eval'", "https: ", "http:", "'self'", "*", "allow-"]) {
		expect(SCRIPTED_HTML_CSP).not.toContain(open);
	}
});

test("a scripted document is the host prefix followed by the unchanged source", () => {
	const source =
		'<!DOCTYPE html><html class="dark"><head><meta http-equiv="Content-Security-Policy" content="default-src *"><base href="https://attacker.invalid/"></head><body><script>draw()</script></body></html>\n';
	const theme = ":root{--accent:#123456}";
	const prefix = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${SCRIPTED_HTML_CSP}"><style data-thinkrail-theme>${theme}</style><script>${FRAME_BOOTSTRAP}</script></head>`;
	expect(buildScriptedHtmlDocument(source, theme)).toBe(prefix + source);
	expect(buildScriptedHtmlDocument("", theme)).toBe(prefix);
});

test("a theme that holds markup becomes an empty theme", () => {
	const prefix = buildScriptedHtmlDocument("", ":root{--x:1}</style><script>attack()</script>");
	expect(prefix).toContain("<style data-thinkrail-theme></style>");
	expect(prefix).not.toContain("attack()");
});

test("the bootstrap is strict and cannot end its own script element", () => {
	expect(FRAME_BOOTSTRAP).toStartWith('(() => {\n\t"use strict";');
	for (const breakout of ["</script", "<!--", "${"]) {
		expect(FRAME_BOOTSTRAP.toLowerCase()).not.toContain(breakout);
	}
});

interface FakeFrame {
	posted: unknown[];
	events: string[];
	theme: { textContent: string };
	scrolls: number[];
	root: { height: number; clientHeight: number; scrollHeight: number; scrollTop: number };
	resize(viewport: number): void;
	observe(): void;
	deliver(type: string, event?: unknown): void;
	host: object;
	shadowGlobals(): void;
	scriptRemoved(): boolean;
	rename(name: string): { read: unknown; engine: string; deleted: boolean };
}

function bootFrame(): FakeFrame {
	const posted: unknown[] = [];
	const events: string[] = [];
	const scrolls: number[] = [];
	const listeners = new Map<string, (event?: unknown) => void>();
	const theme = { textContent: ":root{}" };
	const host = { postMessage: (message: unknown) => posted.push(message) };
	const root = { height: 0, clientHeight: 480, scrollHeight: 480, scrollTop: 0 };
	let viewport = 480;
	let removed = false;
	let engineName = "";
	let observed: () => void = () => {};
	const context: Record<string, unknown> = {
		parent: host,
		addEventListener: (type: string, listener: (event?: unknown) => void) =>
			listeners.set(type, listener),
		dispatchEvent: (event: { type: string }) => events.push(event.type),
		Event: class {
			readonly type: string;
			constructor(type: string) {
				this.type = type;
			}
		},
		ResizeObserver: class {
			constructor(callback: () => void) {
				observed = callback;
			}
			observe() {}
		},
		Math,
		Object,
		document: {
			documentElement: {
				getBoundingClientRect: () => ({ height: root.height }),
				scrollTo: ({ top }: { top: number }) => {
					scrolls.push(top);
					root.scrollTop = Math.min(top, Math.max(0, root.scrollHeight - root.clientHeight));
				},
				get clientHeight() {
					return root.clientHeight;
				},
				get scrollHeight() {
					return root.scrollHeight;
				},
				get scrollTop() {
					return root.scrollTop;
				},
			},
			currentScript: {
				previousElementSibling: theme,
				remove: () => {
					removed = true;
				},
			},
		},
	};
	Object.defineProperty(context, "innerHeight", {
		configurable: true,
		enumerable: true,
		get: () => viewport,
		set: (value) => Object.defineProperty(context, "innerHeight", { value, writable: true }),
	});
	Object.defineProperty(context, "name", {
		configurable: true,
		enumerable: true,
		get: () => engineName,
		set: (value) => {
			engineName = String(value);
		},
	});
	context.window = context;
	runInNewContext(FRAME_BOOTSTRAP, context);
	return {
		posted,
		events,
		theme,
		scrolls,
		root,
		host,
		resize: (next) => {
			viewport = next;
			root.clientHeight = next;
			listeners.get("resize")?.();
		},
		observe: () => observed(),
		deliver: (type, event) => listeners.get(type)?.(event),
		shadowGlobals: () => {
			for (const name of Object.keys(context)) context[name] = 1;
		},
		scriptRemoved: () => removed,
		rename: (name) => {
			context.name = name;
			const deleted = Reflect.deleteProperty(context, "name");
			context.name = name;
			return { read: context.name, engine: engineName, deleted };
		},
	};
}

const report = (seq: number, viewport: number, flow: number, extent: number, scroll = 0) => ({
	type: "thinkrail:height",
	seq,
	viewport,
	flow,
	extent,
	scroll,
});

test("the bootstrap keeps working after author code replaces every global it uses", () => {
	const frame = bootFrame();
	expect(frame.scriptRemoved()).toBe(true);
	frame.shadowGlobals();

	frame.root.height = 319.2;
	frame.observe();
	expect(frame.posted).toEqual([]);

	frame.deliver("message", { source: frame.host, data: themeMessage(":root{--a:1}", 4) });
	expect(frame.theme.textContent).toBe(":root{--a:1}");
	expect(frame.posted).toEqual([{ type: "thinkrail:ready", seq: 4 }, report(4, 480, 320, 480)]);
	expect(frame.events).toEqual(["thinkrail:themechange"]);

	frame.deliver("message", { source: frame.host, data: themeMessage(":root{--a:1}") });
	expect(frame.events).toHaveLength(1);
	expect(frame.posted).toHaveLength(2);
});

test("the bootstrap reports what it reads at each frame height, once per change", () => {
	const frame = bootFrame();
	frame.root.height = 300;
	frame.deliver("message", { source: frame.host, data: themeMessage(":root{}", 1) });
	frame.observe();
	frame.deliver("scroll");
	expect(frame.posted).toEqual([{ type: "thinkrail:ready", seq: 1 }, report(1, 480, 300, 480)]);

	frame.root.scrollHeight = 8192;
	frame.resize(8192);
	frame.observe();
	expect(frame.posted.at(-1)).toEqual(report(1, 8192, 300, 8192));
	expect(frame.posted).toHaveLength(3);

	frame.root.clientHeight = 8177;
	frame.root.scrollHeight = 8177;
	frame.observe();
	expect(frame.posted.at(-1)).toEqual(report(1, 8192, 315, 8192));

	frame.deliver("message", { source: frame.host, data: themeMessage(":root{}", 2) });
	expect(frame.posted.slice(-2)).toEqual([
		{ type: "thinkrail:ready", seq: 2 },
		report(2, 8192, 315, 8192),
	]);
});

test("the bootstrap puts the scroll offset back when the frame height returns", () => {
	const frame = bootFrame();
	frame.root.height = 5000;
	frame.root.scrollHeight = 5000;
	frame.root.scrollTop = 900;
	frame.deliver("message", { source: frame.host, data: themeMessage(":root{}", 1) });
	expect(frame.posted.at(-1)).toEqual(report(1, 480, 5000, 5000, 900));

	frame.root.scrollTop = 0;
	frame.root.scrollHeight = 8192;
	frame.resize(8192);
	frame.deliver("message", { source: {}, data: { type: "thinkrail:scroll", top: 40 } });
	frame.deliver("message", { source: frame.host, data: { type: "thinkrail:scroll", top: "900" } });
	expect(frame.scrolls).toEqual([]);
	frame.deliver("message", { source: frame.host, data: { type: "thinkrail:scroll", top: 900 } });
	expect(frame.root.scrollTop).toBe(0);

	frame.root.scrollHeight = 5000;
	frame.resize(480);
	expect(frame.root.scrollTop).toBe(900);
	expect(frame.posted.at(-1)).toEqual(report(1, 480, 5000, 5000, 900));
	frame.resize(500);
	expect(frame.scrolls).toEqual([900, 900]);
});

test("the bootstrap takes a theme only from the parent window", () => {
	const frame = bootFrame();
	frame.deliver("message", { source: {}, data: themeMessage(":root{--stolen:1}", 1) });
	frame.deliver("message", { source: frame.host, data: { type: "thinkrail:theme", css: 7 } });
	frame.deliver("message", { source: frame.host, data: null });
	expect(frame.theme.textContent).toBe(":root{}");
	expect(frame.posted).toEqual([]);
	expect(frame.events).toEqual([]);
});

test("the bootstrap locks the window name, so a mockup cannot name its frame", () => {
	const frame = bootFrame();
	expect(frame.rename("__THINKRAIL_DESKTOP_SHELL__")).toEqual({
		read: "",
		engine: "",
		deleted: false,
	});
});

test("the bootstrap cancels a click on a link and leaves other clicks alone", () => {
	const frame = bootFrame();
	const click = (path: { localName?: unknown; hasAttribute?: (name: string) => boolean }[]) => {
		let prevented = false;
		frame.deliver("click", {
			composedPath: () => path,
			preventDefault: () => {
				prevented = true;
			},
		});
		return prevented;
	};
	const span = { localName: "span" };
	const link = (attribute: string) => ({
		localName: "a",
		hasAttribute: (name: string) => name === attribute,
	});
	expect(click([span, link("href"), {}])).toBe(true);
	expect(click([span, link("xlink:href"), {}])).toBe(true);
	expect(click([{ localName: "area", hasAttribute: () => true }])).toBe(true);
	expect(click([span, link("name"), {}])).toBe(false);
	expect(click([{ localName: "button" }, { localName: {} }, {}])).toBe(false);
});

test("the parent accepts a frame message only from its frame, in the expected shape", () => {
	const frameWindow = {};
	const frame = { window: frameWindow, seq: 2 };
	const from = (data: unknown, source: unknown = frameWindow) =>
		acceptFrameMessage({ source: source as MessageEventSource, data }, frame);
	const reading = { viewport: 8192, flow: 640, extent: 8192, scroll: 0 };
	expect(from({ type: "thinkrail:ready", seq: 2 })).toEqual({ kind: "ready" });
	expect(from(report(2, 8192, 640, 8192))).toEqual({ kind: "height", report: reading });

	expect(from({ type: "thinkrail:ready", seq: 2 }, {})).toBeNull();
	expect(from(report(2, 8192, 640, 8192), null)).toBeNull();
	expect(
		acceptFrameMessage(
			{ source: null, data: { type: "thinkrail:ready", seq: 0 } },
			{
				window: null,
				seq: 0,
			},
		),
	).toBeNull();
	for (const stale of [1, 3, "2", undefined]) {
		expect(from({ type: "thinkrail:ready", seq: stale })).toBeNull();
		expect(from({ ...report(2, 8192, 640, 8192), seq: stale })).toBeNull();
	}
	for (const name of ["viewport", "flow", "extent", "scroll"]) {
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, "640", null, undefined]) {
			expect(from({ ...report(2, 8192, 640, 8192), [name]: value })).toBeNull();
		}
	}
	for (const data of [null, "thinkrail:ready", 7, { type: "thinkrail:leave", seq: 2 }, {}]) {
		expect(from(data)).toBeNull();
	}
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a ready answer after the first deadline and before the confirm deadline keeps the mockup", async () => {
	const dead: number[] = [];
	const late = createFrameWatch({ readyMs: 5, confirmMs: 60 });
	expect(late.load(() => dead.push(1))).toBe(1);
	await pause(25);
	late.ready();
	await pause(90);
	expect(dead).toEqual([]);

	const silent = createFrameWatch({ readyMs: 5, confirmMs: 20 });
	silent.load(() => dead.push(2));
	await pause(15);
	expect(dead).toEqual([]);
	await pause(60);
	expect(dead).toEqual([2]);

	const reloaded = createFrameWatch({ readyMs: 5, confirmMs: 20 });
	reloaded.load(() => dead.push(3));
	await pause(15);
	expect(reloaded.load(() => dead.push(4))).toBe(2);
	expect(reloaded.seq()).toBe(2);
	reloaded.stop();
	await pause(60);
	expect(dead).toEqual([2]);
});

test("a frame that sends more messages in a second than the limit is flooding until its next load", () => {
	const watch = createFrameWatch();
	watch.load(() => {});
	const verdicts = (count: number, at: number) =>
		new Set(Array.from({ length: count }, () => watch.receive(at)));
	expect(verdicts(FRAME_WATCH.messages, 10)).toEqual(new Set(["accept"]));
	expect(verdicts(FRAME_WATCH.messages, 10 + FRAME_WATCH.windowMs)).toEqual(new Set(["accept"]));
	expect(watch.receive(10 + FRAME_WATCH.windowMs + 1)).toBe("flood");
	expect(verdicts(50, 10 + 5 * FRAME_WATCH.windowMs)).toEqual(new Set(["ignore"]));
	watch.load(() => {});
	expect(watch.receive(10 + 5 * FRAME_WATCH.windowMs)).toBe("accept");
	watch.stop();
});

test("a reload does not reset the message count of the running second", () => {
	const watch = createFrameWatch();
	watch.load(() => {});
	const verdicts = (count: number, at: number) =>
		Array.from({ length: count }, () => watch.receive(at));
	expect(new Set(verdicts(990, 20))).toEqual(new Set(["accept"]));
	watch.load(() => {});
	expect(new Set(verdicts(10, 500))).toEqual(new Set(["accept"]));
	expect(watch.receive(500)).toBe("flood");
	watch.stop();
});

const appWindow: { parent?: unknown } = {};
appWindow.parent = appWindow;

const messageFrom = (source: unknown, origin = "null") => ({
	source: source as MessageEventSource | null,
	origin,
});

function nestedIn(frameWindow: object, depth: number): object {
	return depth === 0 ? frameWindow : { parent: nestedIn(frameWindow, depth - 1) };
}

test("a message belongs to the mockup whose frame its sender sits in", () => {
	const frame = { parent: appWindow };
	const sibling = { parent: appWindow };
	const sender = (source: unknown, origin?: string) =>
		frameSender(messageFrom(source, origin), frame);
	expect(sender(frame)).toBe("frame");
	expect(sender(nestedIn(frame, 1))).toBe("frame");
	expect(sender(nestedIn(frame, 7))).toBe("frame");
	expect(sender(sibling)).toBe("other");
	expect(sender(nestedIn(sibling, 2))).toBe("other");
	expect(sender(appWindow, "http://localhost:3000")).toBe("other");
	expect(sender(null, "http://localhost:3000")).toBe("other");
	expect(sender(null)).toBe("untraced");
	expect(sender({ parent: null })).toBe("untraced");
	expect(sender(nestedIn(frame, 8))).toBe("untraced");
});

test("a flood from one mockup, nested frame or not, closes that mockup and not the one next to it", () => {
	const loud = { parent: appWindow };
	const quiet = { parent: appWindow };
	const mounted = [loud, quiet].map((frame) => ({ frame, watch: createFrameWatch() }));
	const deliver = (source: unknown, at: number) =>
		mounted.map(({ frame, watch }) => watch.receive(at, frameSender(messageFrom(source), frame)));
	const start = 100_000;
	for (let sent = 0; sent < FRAME_WATCH.messages; sent += 1) {
		expect(deliver(sent % 2 === 0 ? loud : nestedIn(loud, 1), start)).toEqual(["accept", "ignore"]);
	}
	expect(deliver(nestedIn(loud, 1), start)).toEqual(["flood", "ignore"]);

	for (let queued = 0; queued < 2 * FRAME_WATCH.messages; queued += 1) {
		expect(deliver(null, start + 400)).toEqual(["ignore", "ignore"]);
	}
	expect(deliver({ parent: null }, start + FRAME_WATCH.tailMs - 1)).toEqual(["ignore", "ignore"]);

	const later = start + FRAME_WATCH.tailMs;
	const verdicts = Array.from({ length: FRAME_WATCH.messages + 1 }, () => deliver(null, later)[1]);
	expect(new Set(verdicts.slice(0, -1))).toEqual(new Set(["accept"]));
	expect(verdicts.at(-1)).toBe("flood");
});

test("a height of any size still goes through the content-height clamp", () => {
	expect(clampContentHeight(1e12)).toBe(HTML_CONTENT_HEIGHT.max);
	expect(clampContentHeight(0)).toBe(HTML_CONTENT_HEIGHT.min);
});

test("the scripted document and the live theme message carry the same layered theme text", () => {
	const theme = themeCss({ names: ["--accent"], value: () => "#123456", colorScheme: "dark" });
	expect(theme).toStartWith("@layer thinkrail-theme{:root{");
	expect(buildScriptedHtmlDocument("", theme)).toContain(
		`<style data-thinkrail-theme>${theme}</style><script>`,
	);
	expect(themeMessage(theme, 1)).toEqual({ type: "thinkrail:theme", css: theme, seq: 1 });
});

function renderView(mode: ResourceHtmlMode, scope?: { kind: "uncommitted" }) {
	let parsed = 0;
	const restore = installFakeDocument((markup) => {
		parsed += 1;
		return parseFakeMarkup(markup);
	});
	const host = { html: { mode: () => mode } } as unknown as ResourceHost;
	try {
		const markup = renderToStaticMarkup(
			<ResourceHostProvider value={host}>
				<ResourceEnvironmentProvider value={{ mobile: false }}>
					<HtmlView
						resource={describeResource("w1", "mockup.html", PENDING_TEXT_META, scope)}
						content={{
							kind: "text",
							text: "<html><head></head><body><p>chart</p><script>draw()</script></body></html>",
							hash: "h1",
						}}
					/>
				</ResourceEnvironmentProvider>
			</ResourceHostProvider>,
		);
		return { markup, parsed };
	} finally {
		restore();
	}
}

function sandboxes(markup: string): (string | undefined)[] {
	return [...markup.matchAll(/<iframe[^>]*?\ssandbox="([^"]*)"/g)].map((match) => match[1]);
}

test("a scripted frame carries exactly allow-scripts, its own notice and the unparsed source", () => {
	const { markup, parsed } = renderView("scripted");
	expect(markup).toContain('data-html-mode="scripted"');
	expect(sandboxes(markup)).toEqual(["allow-scripts"]);
	expect(markup).not.toContain("allow-same-origin");
	const [tag = ""] = markup.match(/<iframe[^>]*>/) ?? [];
	const attributes = tag.replace(/\ssrcdoc="[^"]*"/i, "").matchAll(/\s([a-z-]+)=/gi);
	expect([...attributes].map((match) => match[1]?.toLowerCase())).toEqual([
		"title",
		"sandbox",
		"class",
	]);
	expect(markup).toContain("draw()");
	expect(parsed).toBe(0);
});

test("a side that shows a git revision is themed at most", () => {
	const { markup, parsed } = renderView("scripted", { kind: "uncommitted" });
	expect(markup).toContain('data-html-mode="themed"');
	expect(sandboxes(markup)).toEqual(["allow-same-origin"]);
	expect(markup).toContain("chart");
	expect(markup).not.toContain("draw()");
	expect(parsed).toBe(2);
});

test("the closed notice takes the keyboard focus only for a mockup that held it", () => {
	const plain = renderToStaticMarkup(<MockupStoppedNotice focus={false} />);
	expect(plain).toContain('role="status"');
	expect(plain).not.toContain("tabindex");
	expect(renderToStaticMarkup(<MockupStoppedNotice focus />)).toContain('tabindex="-1"');
});
