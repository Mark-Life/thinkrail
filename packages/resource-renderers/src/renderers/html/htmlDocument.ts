export const HTML_PREVIEW_CSP =
	"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; child-src 'none'";

const REMOVED_ELEMENTS = new Set([
	"script",
	"template",
	"base",
	"link",
	"object",
	"embed",
	"iframe",
	"frame",
	"form",
	"input",
	"button",
	"select",
	"textarea",
	"area",
]);
const REMOVED_ATTRIBUTES = new Set([
	"ping",
	"formaction",
	"srcdoc",
	"xlink:href",
	"srcset",
	"imagesrcset",
]);

const EMPTY_PREVIEW_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"></head><body></body></html>`;

function isDataUrl(value: string): boolean {
	return /^data:/i.test(value.trim());
}

function elementName(element: Element): string {
	const name: unknown = element.localName;
	return typeof name === "string" ? name.toLowerCase() : "form";
}

function animatesHref(element: Element): boolean {
	return Array.from(element.attributes).some(
		(attribute) =>
			attribute.name.toLowerCase() === "attributename" &&
			attribute.value.toLowerCase().includes("href"),
	);
}

function removeElement(element: Element, name: string): boolean {
	return (
		REMOVED_ELEMENTS.has(name) ||
		(name === "meta" && element.getAttribute("http-equiv") !== null) ||
		((name === "set" || name === "animate") && animatesHref(element))
	);
}

function sanitizeElement(element: Element, name: string): number {
	let removed = 0;
	for (const child of Array.from(element.children)) {
		const childName = elementName(child);
		if (removeElement(child, childName)) {
			element.removeChild(child);
			removed += 1;
		} else {
			removed += sanitizeElement(child, childName);
		}
	}

	if (name === "a") {
		const href = Array.from(element.attributes).find((attribute) =>
			["href", "xlink:href"].includes(attribute.name.toLowerCase()),
		)?.value;
		if (href !== undefined) {
			element.setAttribute("data-href", href);
			element.setAttribute("title", href);
		}
	}

	for (const attribute of Array.from(element.attributes)) {
		const attributeName = attribute.name.toLowerCase();
		if (
			attributeName.startsWith("on") ||
			REMOVED_ATTRIBUTES.has(attributeName) ||
			(name === "a" && attributeName === "href") ||
			((attributeName === "src" || attributeName === "href") && !isDataUrl(attribute.value))
		) {
			element.removeAttribute(attribute.name);
			removed += 1;
		}
	}
	return removed;
}

interface PreviewDocument {
	root: Element | null;
	head: Element | null;
	create(name: string): Element;
}

function previewDocument(document: Document): PreviewDocument {
	return {
		root: Reflect.get(Document.prototype, "documentElement", document),
		head: Reflect.get(Document.prototype, "head", document),
		create: (name) => Document.prototype.createElement.call(document, name),
	};
}

export function prepareHtmlPreviewDocument(document: Document): string {
	const { root, head, create } = previewDocument(document);
	if (!root || !head) return EMPTY_PREVIEW_DOCUMENT;
	sanitizeElement(root, elementName(root));
	const charset = create("meta");
	charset.setAttribute("charset", "utf-8");
	const csp = create("meta");
	csp.setAttribute("http-equiv", "Content-Security-Policy");
	csp.setAttribute("content", HTML_PREVIEW_CSP);
	head.prepend(charset, csp);
	if (elementName(root) !== "html" || head.parentNode !== root || csp.parentNode !== head) {
		return EMPTY_PREVIEW_DOCUMENT;
	}
	return `<!doctype html>${root.outerHTML}`;
}

function parseHtml(source: string): Document {
	return new DOMParser().parseFromString(source, "text/html");
}

function parsesBackClean(html: string): boolean {
	const { root, head } = previewDocument(parseHtml(html));
	const csp = head?.children[1];
	if (!root || !head || !csp || csp.getAttribute("content") !== HTML_PREVIEW_CSP) return false;
	head.removeChild(csp);
	return sanitizeElement(root, elementName(root)) === 0;
}

export function buildHtmlPreviewDocument(source: string): string {
	const html = prepareHtmlPreviewDocument(parseHtml(source));
	return html === EMPTY_PREVIEW_DOCUMENT || parsesBackClean(html) ? html : EMPTY_PREVIEW_DOCUMENT;
}
