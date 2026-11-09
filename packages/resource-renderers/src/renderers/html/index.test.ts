import { afterAll, beforeAll, expect, test } from "bun:test";
import { currentTranslator } from "@thinkrail/locales/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	FakeDocument,
	FakeElement,
	installFakeDocument,
	parseFakeMarkup,
} from "../../testing/fakeDocument";
import { htmlRenderer } from ".";
import { HtmlFrame } from "./HtmlFrame";
import {
	buildHtmlPreviewDocument,
	HTML_PREVIEW_CSP,
	prepareHtmlPreviewDocument,
} from "./htmlDocument";

let restoreDocument = () => {};
beforeAll(() => {
	restoreDocument = installFakeDocument();
});
afterAll(() => restoreDocument());

function hostileDocument(): FakeDocument {
	const head = new FakeElement("head", {}, "", [
		new FakeElement("meta", { "http-equiv": "refresh", content: "0;url=https://attacker.invalid" }),
		new FakeElement("base", { href: "https://attacker.invalid/" }),
		new FakeElement("link", { rel: "stylesheet", href: "https://attacker.invalid/site.css" }),
	]);
	const body = new FakeElement("body", {}, "", [
		new FakeElement(
			"a",
			{
				href: "https://attacker.invalid/path",
				ping: "https://attacker.invalid/ping",
				onclick: "location='https://attacker.invalid'",
			},
			"external",
		),
		new FakeElement("script", {}, "location='https://attacker.invalid'"),
		new FakeElement("form", { action: "https://attacker.invalid" }, "form"),
		new FakeElement("object", { data: "https://attacker.invalid/object" }),
		new FakeElement("embed", { src: "https://attacker.invalid/embed" }),
		new FakeElement("iframe", { srcdoc: "<script>attack()</script>" }),
		new FakeElement("input", { formaction: "https://attacker.invalid" }),
		new FakeElement("button", { formaction: "https://attacker.invalid" }, "button"),
		new FakeElement("select"),
		new FakeElement("textarea"),
		new FakeElement("area", { href: "https://attacker.invalid" }),
		new FakeElement("img", { src: "https://attacker.invalid/pixel.png" }),
		new FakeElement("img", { src: "javascript:attack()", onerror: "attack()" }),
		new FakeElement("img", { src: "vbscript:attack()" }),
		new FakeElement("img", { src: "data:image/png;base64,cG5n" }),
		new FakeElement("img", { srcset: "https://attacker.invalid/set.png 1x" }),
		new FakeElement("source", { imagesrcset: "https://attacker.invalid/source.png 1x" }),
		new FakeElement("frame", { src: "data:text/html,<p>frame</p>" }),
		new FakeElement("div", {}, "", [
			new FakeElement("template", { shadowrootmode: "open" }, "", [
				new FakeElement("a", { href: "https://attacker.invalid/shadow" }, "shadow"),
			]),
		]),
		new FakeElement("div", { style: "color: red", onmouseover: "attack()" }, "styled"),
		new FakeElement("svg", {}, "", [
			new FakeElement("use", { "xlink:href": "javascript:attack()" }),
			new FakeElement("a", {}, "", [
				new FakeElement("set", { attributeName: "href", to: "javascript:attack()" }),
				new FakeElement("animate", { attributeName: "xlink:HREF", values: "https://smil.invalid" }),
				new FakeElement("animate", { attributeName: "opacity", values: "0;1" }),
			]),
			new FakeElement("animateTransform", { attributeName: "transform", type: "rotate" }),
		]),
	]);
	return new FakeDocument(head, body);
}

test("HTML renderer registration has no review geometry and stays sandboxed", () => {
	expect(currentTranslator()(htmlRenderer.labelKey)).toBe("Preview");
	expect(htmlRenderer).toMatchObject({
		id: "thinkrail/html",
		labelKey: "viewer.renderer.preview",
		match: { glob: ["*.html", "*.htm"], text: true },
		rank: 120,
		capabilities: {
			anchors: { view: [], diff: [] },
			mobile: true,
			copy: false,
			layout: false,
			whitespace: false,
		},
	});
});

test("HTML preview sanitization neutralizes active elements, navigation, and hostile URLs", () => {
	const document = prepareHtmlPreviewDocument(hostileDocument() as unknown as Document);
	expect(document).toContain(`content="${HTML_PREVIEW_CSP}"`);
	expect(document.match(/Content-Security-Policy/g)).toHaveLength(1);
	expect(document).toContain(
		'<a data-href="https://attacker.invalid/path" title="https://attacker.invalid/path">external</a>',
	);
	expect(document).toContain('<img src="data:image/png;base64,cG5n"></img>');
	expect(document).toContain('<div style="color: red">styled</div>');
	expect(document).toContain('<animate attributeName="opacity" values="0;1"></animate>');
	expect(document).toContain(
		'<animateTransform attributeName="transform" type="rotate"></animateTransform>',
	);
	for (const fragment of [
		'http-equiv="refresh"',
		"<base",
		"<link",
		"<script",
		"<form",
		"<object",
		"<embed",
		"<iframe",
		"<input",
		"<button",
		"<select",
		"<textarea",
		"<area",
		"<frame",
		"<template",
		"<set",
		"shadow",
		"smil.invalid",
		"srcset=",
		"javascript:",
		"vbscript:",
		"https://attacker.invalid/pixel.png",
		"onerror=",
		"onclick=",
		"onmouseover=",
		"ping=",
		"formaction=",
		"srcdoc=",
		"xlink:href=",
	]) {
		expect(document).not.toContain(fragment);
	}
});

const policyOnly = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"></head><body></body></html>`;
const authorBody = () => new FakeElement("body", {}, "", [new FakeElement("p", {}, "author")]);

class DroppingHead extends FakeElement {
	override prepend(): void {
		return;
	}
}

test("a document without a real root or head, or whose head does not hold the policy, yields only the policy", () => {
	const detachedHead = new FakeElement("head");
	const detached = new FakeDocument(detachedHead, authorBody());
	detached.documentElement?.removeChild(detachedHead);
	const documents = {
		"a root that is not html": new FakeDocument(new FakeElement("head"), authorBody(), "form"),
		"no root": new FakeDocument(new FakeElement("head"), authorBody(), null),
		"no head": new FakeDocument(null, authorBody()),
		"a head outside the root": detached,
		"a head that drops the policy": new FakeDocument(new DroppingHead("head"), authorBody()),
	};
	for (const [name, document] of Object.entries(documents)) {
		expect(prepareHtmlPreviewDocument(document as unknown as Document), name).toBe(policyOnly);
	}
});

test("properties that author markup can shadow on the document are not read", () => {
	const shadowed = new FakeDocument(new FakeElement("head"), authorBody());
	for (const name of ["head", "documentElement", "createElement"]) {
		Object.defineProperty(shadowed, name, { value: new FakeElement("img", { name }) });
	}
	expect(prepareHtmlPreviewDocument(shadowed as unknown as Document)).toBe(
		`<!doctype html><html><head><meta charset="utf-8"></meta><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"></meta></head><body><p>author</p></body></html>`,
	);
});

const hostileSource = () => hostileDocument().documentElement?.outerHTML ?? "";

test("a built document is the sanitized document when it parses back with nothing to remove", () => {
	const sanitized = prepareHtmlPreviewDocument(hostileDocument() as unknown as Document);
	expect(sanitized).toContain("styled");
	expect(buildHtmlPreviewDocument(hostileSource())).toBe(sanitized);
});

test("a built document that parses back with something to remove is only the policy", () => {
	const secondParses: Record<string, (reparsed: FakeDocument) => FakeDocument> = {
		"a revived element": (reparsed) => {
			reparsed.documentElement?.children[1]?.append(
				new FakeElement("link", { rel: "preload", as: "image" }),
			);
			return reparsed;
		},
		"a revived attribute": (reparsed) => {
			reparsed.documentElement?.children[1]?.append(
				new FakeElement("img", { srcset: "https://attacker.invalid/set.png 1x" }),
			);
			return reparsed;
		},
		"a head without the policy": () =>
			new FakeDocument(
				new FakeElement("head", {}, "", [
					new FakeElement("meta", { charset: "utf-8" }),
					new FakeElement("style"),
				]),
				new FakeElement("body"),
			),
	};
	for (const [name, secondParse] of Object.entries(secondParses)) {
		const restore = installFakeDocument((markup) =>
			markup.startsWith("<!doctype html>")
				? secondParse(parseFakeMarkup(markup))
				: parseFakeMarkup(markup),
		);
		try {
			expect(buildHtmlPreviewDocument(hostileSource()), name).toBe(policyOnly);
		} finally {
			restore();
		}
	}
});

test("HTML preview CSP is exact", () => {
	expect(HTML_PREVIEW_CSP).toBe(
		"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; child-src 'none'",
	);
});

test("HTML frames carry exactly an empty sandbox capability set", () => {
	const markup = renderToStaticMarkup(
		createElement(HtmlFrame, {
			title: "HTML preview",
			document: "<!doctype html><html><body>preview</body></html>",
		}),
	);
	const iframeAt = markup.indexOf("<iframe");
	const openingTag = markup.slice(iframeAt, markup.indexOf(">", iframeAt) + 1);
	expect(markup.match(/<iframe/g)).toHaveLength(1);
	expect([...openingTag.matchAll(/\ssandbox="([^"]*)"/g)].map((match) => match[1])).toEqual([""]);
	expect(openingTag).not.toContain("allow-");
});
