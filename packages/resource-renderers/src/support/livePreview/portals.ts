import { WidgetType } from "@codemirror/view";
import type { EditConflict } from "../../registry";
import type { LiveBlock } from "./blocks";

export type PortalContent =
	| { kind: "block"; block: LiveBlock }
	| { kind: "thread"; id: string }
	| { kind: "lens"; conflict: EditConflict }
	| { kind: "theirs"; conflict: EditConflict; theirsText: string };

export interface PortalEntry {
	key: number;
	node: HTMLElement;
	content: PortalContent;
}

const INTERACTIVE = "a, button, input, textarea, select, summary, label, [role='button']";

function sameContent(a: PortalContent, b: PortalContent): boolean {
	switch (a.kind) {
		case "block":
			return (
				b.kind === "block" && a.block.kind === b.block.kind && a.block.source === b.block.source
			);
		case "thread":
			return b.kind === "thread" && a.id === b.id;
		case "lens":
			return b.kind === "lens" && a.conflict.id === b.conflict.id;
		case "theirs":
			return (
				b.kind === "theirs" &&
				a.conflict.id === b.conflict.id &&
				a.conflict.theirs === b.conflict.theirs &&
				a.theirsText === b.theirsText
			);
	}
}

export function createPortalHost() {
	let entries: readonly PortalEntry[] = [];
	let seq = 0;
	let onResize = () => {};
	const listeners = new Set<() => void>();
	const sizes = new ResizeObserver(() => onResize());
	const emit = () => {
		for (const listener of listeners) listener();
	};
	return {
		mount(node: HTMLElement, content: PortalContent) {
			seq += 1;
			entries = [...entries, { key: seq, node, content }];
			sizes.observe(node);
			emit();
		},
		update(node: HTMLElement, content: PortalContent) {
			entries = entries.map((entry) => (entry.node === node ? { ...entry, content } : entry));
			emit();
		},
		unmount(node: HTMLElement) {
			entries = entries.filter((entry) => entry.node !== node);
			sizes.unobserve(node);
			emit();
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		snapshot: () => entries,
		onResize(handler: () => void) {
			onResize = handler;
		},
	};
}

export type PortalHost = ReturnType<typeof createPortalHost>;

export class PortalWidget extends WidgetType {
	constructor(
		readonly content: PortalContent,
		readonly host: PortalHost,
	) {
		super();
	}

	override eq(other: PortalWidget): boolean {
		return other.host === this.host && sameContent(this.content, other.content);
	}

	override toDOM(): HTMLElement {
		const node = document.createElement("div");
		node.className = `md-widget md-widget-${this.content.kind}`;
		this.host.mount(node, this.content);
		return node;
	}

	override updateDOM(dom: HTMLElement, _view: unknown, from: PortalWidget): boolean {
		if (from.content.kind !== this.content.kind || from.host !== this.host) return false;
		this.host.update(dom, this.content);
		return true;
	}

	override destroy(dom: HTMLElement): void {
		this.host.unmount(dom);
	}

	override get estimatedHeight(): number {
		return this.content.kind === "block" ? 48 : 36;
	}

	override ignoreEvent(event: Event): boolean {
		if (this.content.kind !== "block") return true;
		return event.target instanceof Element && event.target.closest(INTERACTIVE) !== null;
	}
}
