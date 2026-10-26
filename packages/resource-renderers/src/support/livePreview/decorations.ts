import { syntaxTree } from "@codemirror/language";
import {
	type EditorState,
	Facet,
	type Range,
	StateEffect,
	StateField,
	type Transaction,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import type { EditConflict } from "../../registry";
import { conflictSpan } from "../conflictLayout";
import { frontmatterBlock, type LiveBlock, liveBlocks } from "./blocks";
import { type InlineStyle, type LineStyle, type LiveMark, liveMarks, type Span } from "./markers";
import { type PortalContent, type PortalHost, PortalWidget } from "./portals";

export interface LiveText {
	task: string;
	followLink: string;
}

export const portalHost = Facet.define<PortalHost, PortalHost | null>({
	combine: (values) => values[0] ?? null,
});

export const liveText = Facet.define<LiveText, LiveText>({
	combine: (values) => values[0] ?? { task: "", followLink: "" },
});

export const setFocused = StateEffect.define<boolean>();

const focusField = StateField.define<boolean>({
	create: () => false,
	update(focused, tr) {
		for (const effect of tr.effects) if (effect.is(setFocused)) return effect.value;
		return focused;
	},
});

function liveSelection(state: EditorState): Span[] | null {
	if (!state.field(focusField)) return null;
	return state.selection.ranges.map((range) => ({ from: range.from, to: range.to }));
}

function focusChanged(tr: Transaction): boolean {
	return tr.effects.some((effect) => effect.is(setFocused));
}

interface BlockState {
	blocks: readonly LiveBlock[];
	decorations: DecorationSet;
}

function buildBlocks(state: EditorState): BlockState {
	const host = state.facet(portalHost);
	const blocks = liveBlocks({
		tree: syntaxTree(state),
		doc: state.doc,
		selection: liveSelection(state),
	});
	const decorations = host
		? Decoration.set(
				blocks.map((block) =>
					Decoration.replace({
						widget: new PortalWidget({ kind: "block", block }, host),
						block: true,
					}).range(block.from, block.to),
				),
			)
		: Decoration.none;
	return { blocks, decorations };
}

export const blockField = StateField.define<BlockState>({
	create: buildBlocks,
	update(value, tr) {
		const reparsed = syntaxTree(tr.startState) !== syntaxTree(tr.state);
		if (!tr.docChanged && !tr.selection && !reparsed && !focusChanged(tr)) return value;
		return buildBlocks(tr.state);
	},
	provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

class BulletWidget extends WidgetType {
	override eq(): boolean {
		return true;
	}
	override toDOM(): HTMLElement {
		const node = document.createElement("span");
		node.className = "md-bullet";
		node.textContent = "•";
		return node;
	}
}

class RuleWidget extends WidgetType {
	override eq(): boolean {
		return true;
	}
	override toDOM(): HTMLElement {
		const node = document.createElement("span");
		node.className = "md-rule";
		node.setAttribute("role", "separator");
		return node;
	}
}

class TaskWidget extends WidgetType {
	constructor(
		readonly checked: boolean,
		readonly label: string,
	) {
		super();
	}
	override eq(other: TaskWidget): boolean {
		return other.checked === this.checked && other.label === this.label;
	}
	override toDOM(view: EditorView): HTMLElement {
		const box = document.createElement("input");
		box.type = "checkbox";
		box.checked = this.checked;
		box.className = "md-task";
		box.setAttribute("aria-label", this.label);
		box.addEventListener("mousedown", (event) => event.preventDefault());
		box.addEventListener("click", (event) => {
			event.preventDefault();
			const at = view.posAtDOM(box);
			view.dispatch({
				changes: { from: at + 1, to: at + 2, insert: this.checked ? " " : "x" },
				userEvent: "input",
			});
		});
		return box;
	}
	override ignoreEvent(): boolean {
		return true;
	}
}

const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });
const hidden = Decoration.replace({});

const STYLE_CLASS: Readonly<Record<InlineStyle, string>> = {
	strong: "md-strong",
	em: "italic",
	strike: "line-through",
	code: "md-code rounded-sm bg-sunken",
	link: "md-link text-primary underline decoration-primary-muted underline-offset-2",
	marker: "md-marker tr-code-text text-text-subtle",
};

const LINE_CLASS: Readonly<Record<LineStyle, string>> = {
	h1: "md-h1",
	h2: "md-h2",
	h3: "md-h3",
	h4: "md-h4",
	h5: "md-h5",
	h6: "md-h6",
	quote: "md-quote",
	codeblock: "md-codeblock",
};

function lineDecoration(style: LineStyle): Decoration {
	const level = /^h([1-6])$/.exec(style)?.[1];
	return Decoration.line({
		class: LINE_CLASS[style],
		...(level ? { attributes: { role: "heading", "aria-level": level } } : {}),
	});
}

function markDecoration(mark: LiveMark, text: LiveText): Range<Decoration> | null {
	switch (mark.kind) {
		case "hide":
			return mark.to > mark.from ? hidden.range(mark.from, mark.to) : null;
		case "bullet":
			return bullet.range(mark.from, mark.to);
		case "rule":
			return rule.range(mark.from, mark.to);
		case "task":
			return Decoration.replace({ widget: new TaskWidget(mark.checked, text.task) }).range(
				mark.from,
				mark.to,
			);
		case "line":
			return lineDecoration(mark.style).range(mark.at);
		case "style":
			return Decoration.mark({
				class: STYLE_CLASS[mark.style],
				...(mark.href === undefined
					? {}
					: { attributes: { "data-href": mark.href, title: text.followLink } }),
			}).range(mark.from, mark.to);
	}
}

function buildMarks(view: EditorView): DecorationSet {
	const { state } = view;
	const { blocks } = state.field(blockField);
	const front = frontmatterBlock(state.doc);
	const raw = front && !blocks.some((block) => block.kind === "frontmatter") ? [front] : [];
	const marks = liveMarks({
		tree: syntaxTree(state),
		doc: state.doc,
		ranges: view.visibleRanges,
		selection: liveSelection(state),
		skip: blocks,
		raw,
	});
	const text = state.facet(liveText);
	return Decoration.set(
		marks.flatMap((mark) => markDecoration(mark, text) ?? []),
		true,
	);
}

const markPlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = buildMarks(view);
		}
		update(update: ViewUpdate) {
			if (
				update.docChanged ||
				update.viewportChanged ||
				update.selectionSet ||
				update.focusChanged ||
				syntaxTree(update.startState) !== syntaxTree(update.state) ||
				update.startState.field(blockField) !== update.state.field(blockField) ||
				update.transactions.some(focusChanged)
			) {
				this.decorations = buildMarks(update.view);
			}
		}
	},
	{ decorations: (plugin) => plugin.decorations },
);

export interface ThreadAnchor {
	id: string;
	line: number;
}

export const setThreads = StateEffect.define<readonly ThreadAnchor[]>();

function threadDecorations(state: EditorState, threads: readonly ThreadAnchor[]): DecorationSet {
	const host = state.facet(portalHost);
	if (!host) return Decoration.none;
	return Decoration.set(
		threads.map((thread) =>
			Decoration.widget({
				widget: new PortalWidget({ kind: "thread", id: thread.id }, host),
				block: true,
				side: 1,
			}).range(state.doc.line(Math.min(Math.max(thread.line, 1), state.doc.lines)).to),
		),
		true,
	);
}

const threadField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(value, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setThreads)) return threadDecorations(tr.state, effect.value);
		}
		return value.map(tr.changes);
	},
	provide: (field) => EditorView.decorations.from(field),
});

export const setConflicts = StateEffect.define<readonly EditConflict[]>();

const conflictMine = Decoration.line({ class: "edit-conflict-mine" });

function conflictDecorations(
	state: EditorState,
	conflicts: readonly EditConflict[],
): DecorationSet {
	const host = state.facet(portalHost);
	if (!host) return Decoration.none;
	const { doc } = state;
	const model = {
		getPositionAt: (offset: number) => {
			const line = doc.lineAt(Math.min(offset, doc.length));
			return { lineNumber: line.number, column: Math.min(offset, doc.length) - line.from + 1 };
		},
		getValueLength: () => doc.length,
		getLineMaxColumn: (number: number) => doc.line(number).length + 1,
	};
	const ranges: Range<Decoration>[] = [];
	const widget = (content: PortalContent, pos: number, side: number) =>
		Decoration.widget({ widget: new PortalWidget(content, host), block: true, side }).range(pos);
	for (const conflict of conflicts) {
		const span = conflictSpan(model, conflict);
		const pastEnd = span.startLine > doc.lines;
		ranges.push(
			widget(
				{ kind: "lens", conflict },
				pastEnd ? doc.length : doc.line(span.startLine).from,
				pastEnd ? 1 : -2,
			),
		);
		if (span.endLine !== null) {
			for (let number = span.startLine; number <= Math.min(span.endLine, doc.lines); number += 1) {
				ranges.push(conflictMine.range(doc.line(number).from));
			}
		}
		const after = span.endLine ?? span.startLine - 1;
		const theirs: PortalContent = { kind: "theirs", conflict, theirsText: span.theirsText };
		ranges.push(
			after < 1
				? widget(theirs, 0, -1)
				: widget(theirs, doc.line(Math.min(after, doc.lines)).to, 2),
		);
	}
	return Decoration.set(ranges, true);
}

const conflictField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(value, tr) {
		for (const effect of tr.effects) {
			if (effect.is(setConflicts)) return conflictDecorations(tr.state, effect.value);
		}
		return value.map(tr.changes);
	},
	provide: (field) => EditorView.decorations.from(field),
});

export const livePreview = [focusField, blockField, markPlugin, threadField, conflictField];
