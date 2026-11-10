interface FakeAttribute {
	name: string;
	value: string;
}

export class FakeElement {
	readonly children: FakeElement[] = [];
	readonly localName: string;
	private readonly values = new Map<string, string>();
	private parent: FakeElement | null = null;
	private text: string;

	constructor(
		localName: string,
		attributes: Record<string, string> = {},
		text = "",
		children: readonly FakeElement[] = [],
	) {
		this.localName = localName;
		this.text = text;
		for (const [name, value] of Object.entries(attributes)) this.values.set(name, value);
		for (const child of children) this.append(child);
	}

	get attributes(): FakeAttribute[] {
		return [...this.values].map(([name, value]) => ({ name, value }));
	}

	get parentNode(): FakeElement | null {
		return this.parent;
	}

	set textContent(value: string) {
		this.text = value;
	}

	get outerHTML(): string {
		const attributes = [...this.values]
			.map(([name, value]) => ` ${name}="${escapeMarkup(value)}"`)
			.join("");
		const body = `${escapeMarkup(this.text)}${this.children.map((child) => child.outerHTML).join("")}`;
		return `<${this.localName}${attributes}>${body}</${this.localName}>`;
	}

	append(child: FakeElement): void {
		child.moveTo(this);
		this.children.push(child);
	}

	prepend(...children: FakeElement[]): void {
		for (const child of [...children].reverse()) {
			child.moveTo(this);
			this.children.unshift(child);
		}
	}

	getAttribute(name: string): string | null {
		return this.values.get(name) ?? null;
	}

	setAttribute(name: string, value: string): void {
		this.values.set(name, value);
	}

	removeAttribute(name: string): void {
		this.values.delete(name);
	}

	removeChild(child: FakeElement): void {
		if (child.parent === this) child.moveTo(null);
	}

	private moveTo(parent: FakeElement | null): void {
		const siblings = this.parent?.children;
		const index = siblings?.indexOf(this) ?? -1;
		if (index >= 0) siblings?.splice(index, 1);
		this.parent = parent;
	}
}

export class FakeDocument {
	private readonly root: FakeElement | null;
	private readonly headElement: FakeElement | null;

	constructor(head: FakeElement | null, body: FakeElement, root: string | null = "html") {
		this.headElement = head;
		this.root = root === null ? null : new FakeElement(root, {}, "", head ? [head, body] : [body]);
	}

	get documentElement(): FakeElement | null {
		return this.root;
	}

	get head(): FakeElement | null {
		return this.headElement;
	}

	createElement(name: string): FakeElement {
		return new FakeElement(name);
	}
}

const MARKUP_TOKEN = /<(\/?)([^\s<>/]+)((?:\s[^\s=<>]+="[^"]*")*)>|([^<]+)/g;
const MARKUP_ATTRIBUTE = /\s([^\s=<>]+)="([^"]*)"/g;

export function parseFakeMarkup(markup: string): FakeDocument {
	const holder = new FakeElement("#document");
	const open = [holder];
	for (const [, closing, name = "", attributes = "", text] of markup
		.replace(/^<!doctype html>/, "")
		.matchAll(MARKUP_TOKEN)) {
		const parent = open.at(-1) ?? holder;
		if (text !== undefined) {
			parent.textContent = unescapeMarkup(text);
		} else if (closing) {
			open.pop();
		} else {
			const element = new FakeElement(
				name,
				Object.fromEntries(
					[...attributes.matchAll(MARKUP_ATTRIBUTE)].map(([, key = "", value = ""]) => [
						key,
						unescapeMarkup(value),
					]),
				),
			);
			parent.append(element);
			open.push(element);
		}
	}
	const root = holder.children[0];
	const part = (name: string) => root?.children.find((child) => child.localName === name);
	return new FakeDocument(
		part("head") ?? null,
		part("body") ?? new FakeElement("body"),
		root?.localName ?? null,
	);
}

export function installFakeDocument(
	parse: (markup: string) => FakeDocument = parseFakeMarkup,
): () => void {
	const previous = ["Document", "DOMParser"].map((name): [string, unknown] => [
		name,
		Reflect.get(globalThis, name),
	]);
	Reflect.set(globalThis, "Document", FakeDocument);
	Reflect.set(
		globalThis,
		"DOMParser",
		class {
			parseFromString(markup: string): FakeDocument {
				return parse(markup);
			}
		},
	);
	return () => {
		for (const [name, value] of previous) Reflect.set(globalThis, name, value);
	};
}

function escapeMarkup(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function unescapeMarkup(value: string): string {
	return value
		.replaceAll("&gt;", ">")
		.replaceAll("&lt;", "<")
		.replaceAll("&quot;", '"')
		.replaceAll("&amp;", "&");
}
