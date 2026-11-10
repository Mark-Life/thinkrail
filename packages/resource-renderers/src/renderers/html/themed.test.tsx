import { afterAll, beforeAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	ResourceEnvironmentProvider,
	type ResourceHost,
	ResourceHostProvider,
	type ResourceHtmlMode,
} from "../../host";
import { describeResource, PENDING_TEXT_META } from "../../registry";
import { FakeDocument, FakeElement, installFakeDocument } from "../../testing/fakeDocument";
import { rootCustomPropertyNames, themeCss } from "./hostTheme";
import { HTML_PREVIEW_CSP, prepareHtmlPreviewDocument } from "./htmlDocument";
import HtmlView from "./View";
import { clampContentHeight, HTML_CONTENT_HEIGHT, htmlFitGeometry } from "./viewport";

let restoreDocument = () => {};
beforeAll(() => {
	restoreDocument = installFakeDocument();
});
afterAll(() => restoreDocument());

function mockupDocument(): FakeDocument {
	const head = new FakeElement("head", {}, "", [
		new FakeElement("link", { rel: "stylesheet", href: "thinkrail-theme.css" }),
		new FakeElement("style", {}, ":root{--accent:#bada55}"),
	]);
	const body = new FakeElement("body", {}, "", [
		new FakeElement("script", {}, "render()"),
		new FakeElement("button", { onclick: "toggle()" }, "Toggle"),
		new FakeElement("p", { onclick: "toggle()" }, "chart"),
	]);
	return new FakeDocument(head, body);
}

test("a themed document is the static document plus the theme style before author content", () => {
	const themed = prepareHtmlPreviewDocument(
		mockupDocument() as unknown as Document,
		":root{--accent:#123456}",
	);
	const theme = '<style data-thinkrail-theme="">:root{--accent:#123456}</style>';
	expect(themed).toStartWith(
		`<!doctype html><html><head><meta charset="utf-8"></meta><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"></meta>${theme}<style>:root{--accent:#bada55}</style></head>`,
	);
	expect(themed.replace(theme, "").replace("<button>Toggle</button>", "")).toBe(
		prepareHtmlPreviewDocument(mockupDocument() as unknown as Document),
	);
	for (const removed of ["thinkrail-theme.css", "<script", "onclick="]) {
		expect(themed).not.toContain(removed);
	}
});

function controlsDocument(): FakeDocument {
	const body = new FakeElement("body", {}, "", [
		new FakeElement(
			"button",
			{ onclick: "toggle()", formaction: "https://attacker.invalid" },
			"Go",
		),
		new FakeElement("input", { type: "range", autofocus: "", value: "3" }),
		new FakeElement("select", {}, "", [new FakeElement("option", {}, "One")]),
		new FakeElement("textarea", {}, "note"),
		new FakeElement("form", { name: "documentElement" }, "", [
			new FakeElement("input", { name: "localName", value: "in-form" }),
		]),
	]);
	return new FakeDocument(new FakeElement("head"), body);
}

test("a themed document keeps inert controls outside a form; a static one removes them", () => {
	const themed = prepareHtmlPreviewDocument(controlsDocument() as unknown as Document, "");
	for (const kept of [
		"<button>Go</button>",
		'<input type="range" value="3"></input>',
		"<select><option>One</option></select>",
		"<textarea>note</textarea>",
	]) {
		expect(themed).toContain(kept);
	}
	const document = prepareHtmlPreviewDocument(controlsDocument() as unknown as Document);
	for (const control of ["<button", "<input", "<select", "<textarea"]) {
		expect(document).not.toContain(control);
	}
	for (const markup of [themed, document]) {
		for (const removed of ["<form", "in-form", "autofocus", "onclick=", "formaction="]) {
			expect(markup).not.toContain(removed);
		}
	}
});

function renderView(mode: ResourceHtmlMode | null): string {
	const view = (
		<ResourceEnvironmentProvider value={{ mobile: false }}>
			<HtmlView
				resource={describeResource("w1", "mockup.html", PENDING_TEXT_META)}
				content={{
					kind: "text",
					text: "<html><head></head><body><p>chart</p></body></html>",
					hash: "h1",
				}}
			/>
		</ResourceEnvironmentProvider>
	);
	const host = { html: { mode: () => mode } } as unknown as ResourceHost;
	return renderToStaticMarkup(
		mode === null ? view : <ResourceHostProvider value={host}>{view}</ResourceHostProvider>,
	);
}

function sandboxes(markup: string): (string | undefined)[] {
	return [...markup.matchAll(/<iframe[^>]*?\ssandbox="([^"]*)"/g)].map((match) => match[1]);
}

test("an HTML file is static unless the host answers themed, and neither mode allows scripts", () => {
	const hostless = renderView(null);
	expect(hostless).toContain('data-html-mode="static"');
	expect(hostless).toContain("&lt;p&gt;chart&lt;/p&gt;");
	expect(sandboxes(hostless)).toEqual([""]);
	expect(sandboxes(renderView("static"))).toEqual([""]);

	const themed = renderView("themed");
	expect(themed).toContain('data-html-mode="themed"');
	expect(sandboxes(themed)).toEqual(["allow-same-origin"]);
	expect(themed).toContain("data-thinkrail-theme");
	expect(themed).toContain("&lt;p&gt;chart&lt;/p&gt;");
	expect(hostless).not.toContain("data-thinkrail-theme");
	for (const markup of [hostless, themed]) expect(markup).not.toContain("allow-scripts");
});

test("content height is clamped to the documented bounds", () => {
	expect(clampContentHeight(40)).toBe(HTML_CONTENT_HEIGHT.min);
	expect(clampContentHeight(640.2)).toBe(641);
	expect(clampContentHeight(90_000)).toBe(HTML_CONTENT_HEIGHT.max);
	expect(clampContentHeight(Number.NaN)).toBe(HTML_CONTENT_HEIGHT.min);
	expect(HTML_CONTENT_HEIGHT).toEqual({ min: 120, max: 1600 });
});

test("a fitted frame keeps the design width and clamps the rendered box height", () => {
	expect(htmlFitGeometry("desktop", 640, 900)).toEqual({ width: 1280, height: 900, scale: 0.5 });
	expect(htmlFitGeometry("desktop", 640, 100)).toEqual({ width: 1280, height: 240, scale: 0.5 });
	expect(htmlFitGeometry("desktop", 640, 5000)).toEqual({ width: 1280, height: 3200, scale: 0.5 });
	expect(htmlFitGeometry("desktop", 640, 3200)).toEqual({ width: 1280, height: 3200, scale: 0.5 });
	expect(htmlFitGeometry("responsive", 640, 300)).toEqual({ width: 640, height: 300, scale: 1 });
	expect(htmlFitGeometry("phone", 800, 0)).toEqual({
		width: 390,
		height: HTML_CONTENT_HEIGHT.min,
		scale: 1,
	});
});

function declaration(entries: Record<string, string>): CSSStyleDeclaration {
	const names = Object.keys(entries);
	return {
		length: names.length,
		item: (index: number) => names[index] ?? "",
	} as CSSStyleDeclaration;
}

test("token names come from :root rules, nested groups and the root's inline palette", () => {
	const sheet = {
		cssRules: [
			{ selectorText: ":root", style: declaration({ "--text-default": "", color: "" }) },
			{
				cssRules: [
					{
						selectorText: ':root[data-theme-appearance="dark"]',
						style: declaration({ "--overlay": "" }),
					},
					{ selectorText: ".card", style: declaration({ "--card-only": "" }) },
				],
			},
		],
	} as unknown as CSSStyleSheet;
	const blocked = {
		get cssRules(): CSSRuleList {
			throw new Error("cross-origin");
		},
	} as unknown as CSSStyleSheet;
	const root = { style: declaration({ "--background": "", "color-scheme": "" }) } as HTMLElement;
	expect(rootCustomPropertyNames(root, [sheet, blocked])).toEqual([
		"--background",
		"--overlay",
		"--text-default",
	]);
});

test("theme CSS is one cascade layer without empty values or markup", () => {
	const values: Record<string, string> = {
		"--background": " #09090b ",
		"--breakout": "red}</style><p>",
	};
	const css = themeCss({
		names: ["--background", "--breakout", "--missing"],
		value: (name) => values[name] ?? "",
		colorScheme: "dark",
	});
	expect(css).toStartWith(
		"@layer thinkrail-theme{:root{color-scheme:dark;--background:#09090b;}html{background:var(--container-workspace-bg);",
	);
	expect(css).toEndWith("font-size:var(--tr-font-size-s13)}}");
	expect(css).not.toContain("<");
	expect(css).not.toContain(":where(");
	expect(themeCss({ names: [], value: () => "", colorScheme: "</style>" })).toStartWith(
		"@layer thinkrail-theme{:root{}html{",
	);
});
