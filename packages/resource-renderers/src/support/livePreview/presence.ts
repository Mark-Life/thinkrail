import { type EditorState, type Range, StateEffect, StateField } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	hoverTooltip,
	type Tooltip,
	WidgetType,
} from "@codemirror/view";
import {
	type PresenceLook,
	type PresenceRanges,
	type PresenceSurface,
	presenceClasses,
} from "../presenceCore";
import { PRESENCE_TIMING, type PresenceSpan } from "../presenceDecorations";
import type { Span } from "./markers";

interface PresenceEntry {
	spans: readonly Span[];
	look: PresenceLook | null;
	flag: HTMLElement | null;
}

type PresenceState = ReadonlyMap<number, PresenceEntry>;

const track = StateEffect.define<{ id: number; spans: readonly Span[]; append: boolean }>();
const paint = StateEffect.define<{ id: number; look: PresenceLook }>();
const flag = StateEffect.define<{ id: number; node: HTMLElement | null }>();
const clear = StateEffect.define<number>();

class FlagWidget extends WidgetType {
	constructor(readonly node: HTMLElement) {
		super();
	}
	override eq(other: FlagWidget): boolean {
		return other.node === this.node;
	}
	override toDOM(): HTMLElement {
		return this.node;
	}
}

function lineSpan(state: EditorState, span: Span): PresenceSpan {
	return {
		startLine: state.doc.lineAt(span.from).number,
		endLine: state.doc.lineAt(Math.max(span.from, span.to)).number,
	};
}

function decorations(state: EditorState, entries: PresenceState): DecorationSet {
	const ranges: Range<Decoration>[] = [];
	for (const entry of entries.values()) {
		const { look } = entry;
		if (!look) continue;
		const washing = look.step < PRESENCE_TIMING.washSteps;
		const line = Decoration.line({
			class: `presence-bar ${presenceClasses(look.writer)}${washing ? ` presence-wash presence-wash-${look.step}` : ""}`,
			attributes: { title: look.label },
		});
		for (const span of entry.spans) {
			const { startLine, endLine } = lineSpan(state, span);
			for (let number = startLine; number <= endLine; number += 1) {
				ranges.push(line.range(state.doc.line(number).from));
			}
		}
		const first = entry.spans[0];
		if (entry.flag && first) {
			const end = state.doc.lineAt(first.from).to;
			ranges.push(Decoration.widget({ widget: new FlagWidget(entry.flag), side: 1 }).range(end));
		}
	}
	return Decoration.set(ranges, true);
}

const presenceField = StateField.define<PresenceState>({
	create: () => new Map(),
	update(entries, tr) {
		let next: Map<number, PresenceEntry> | null = null;
		const edit = () => {
			next ??= new Map(entries);
			return next;
		};
		if (tr.docChanged) {
			for (const [id, entry] of entries) {
				edit().set(id, {
					...entry,
					spans: entry.spans.map((span) => {
						const from = tr.changes.mapPos(span.from, 1);
						return { from, to: Math.max(from, tr.changes.mapPos(span.to, -1)) };
					}),
				});
			}
		}
		for (const effect of tr.effects) {
			if (effect.is(track)) {
				const current = (next ?? entries).get(effect.value.id);
				const spans =
					effect.value.append && current
						? [...current.spans, ...effect.value.spans]
						: effect.value.spans;
				edit().set(effect.value.id, {
					look: current?.look ?? null,
					flag: current?.flag ?? null,
					spans,
				});
			} else if (effect.is(paint)) {
				const current = (next ?? entries).get(effect.value.id);
				if (current) edit().set(effect.value.id, { ...current, look: effect.value.look });
			} else if (effect.is(flag)) {
				const current = (next ?? entries).get(effect.value.id);
				if (current) edit().set(effect.value.id, { ...current, flag: effect.value.node });
			} else if (effect.is(clear)) {
				edit().delete(effect.value);
			}
		}
		return next ?? entries;
	},
	provide: (field) =>
		EditorView.decorations.compute([field], (state) => decorations(state, state.field(field))),
});

function hoverAt(view: EditorView, pos: number): Tooltip | null {
	const line = view.state.doc.lineAt(pos).number;
	for (const entry of view.state.field(presenceField).values()) {
		const { look } = entry;
		if (!look) continue;
		const hit = entry.spans.some((span) => {
			const lines = lineSpan(view.state, span);
			return lines.startLine <= line && line <= lines.endLine;
		});
		if (!hit) continue;
		return {
			pos: view.state.doc.line(line).from,
			above: true,
			create: () => {
				const dom = document.createElement("div");
				dom.className = "presence-hover tr-text-metadata text-text-default";
				dom.dataset.presence = "hover";
				const label = dom.appendChild(document.createElement("div"));
				label.textContent = look.label;
				if (look.diff.length > 0) {
					const diff = dom.appendChild(document.createElement("pre"));
					diff.className = "tr-code-text-small text-text-muted";
					diff.textContent = look.diff.join("\n");
				}
				return { dom };
			},
		};
	}
	return null;
}

export const livePresence = [presenceField, hoverTooltip(hoverAt)];

export function livePresenceSurface(view: EditorView, chipHost: HTMLElement): PresenceSurface {
	let seq = 0;
	const toPositions = (spans: readonly PresenceSpan[]) => {
		const { doc } = view.state;
		return spans.map((span) => ({
			from: doc.line(Math.min(span.startLine, doc.lines)).from,
			to: doc.line(Math.min(span.endLine, doc.lines)).to,
		}));
	};
	const ids = new WeakMap<PresenceRanges, number>();
	return {
		track(spans) {
			seq += 1;
			const id = seq;
			view.dispatch({ effects: track.of({ id, spans: toPositions(spans), append: false }) });
			const ranges: PresenceRanges = {
				spans: () =>
					(view.state.field(presenceField).get(id)?.spans ?? []).map((span) =>
						lineSpan(view.state, span),
					),
				paint: (look) => view.dispatch({ effects: paint.of({ id, look }) }),
				append: (more) =>
					view.dispatch({ effects: track.of({ id, spans: toPositions(more), append: true }) }),
				set: (spans) =>
					view.dispatch({ effects: track.of({ id, spans: toPositions(spans), append: false }) }),
				clear: () => view.dispatch({ effects: clear.of(id) }),
			};
			ids.set(ranges, id);
			return ranges;
		},
		flag(ranges, node) {
			const id = ids.get(ranges);
			if (id === undefined) return () => {};
			view.dispatch({ effects: flag.of({ id, node }) });
			return () => view.dispatch({ effects: flag.of({ id, node: null }) });
		},
		chip(node) {
			chipHost.appendChild(node);
			return () => node.remove();
		},
	};
}
