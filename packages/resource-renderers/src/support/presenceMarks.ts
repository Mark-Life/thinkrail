import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import type { PresenceWrite, PresenceWriter } from "../registry";
import type { DiskLanding } from "./monacoMirror";
import {
	diffFence,
	joinDiffs,
	markdownText,
	PRESENCE_TIMING,
	type PresencePaint,
	type PresenceSpan,
	presencePaint,
} from "./presenceDecorations";

export interface PresenceText {
	hover(writer: PresenceWriter): string;
	lines(writer: PresenceWriter, spans: readonly PresenceSpan[]): string;
	places(writer: PresenceWriter, count: number): string;
	file(writer: PresenceWriter): string;
}

interface Mark {
	hash: string;
	paint: PresencePaint;
	ranges: monaco.editor.IEditorDecorationsCollection;
	writer: PresenceWriter | null;
	announcedAt: number;
	flag: monaco.editor.IContentWidget | null;
	chip: monaco.editor.IOverlayWidget | null;
	timers: ReturnType<typeof setTimeout>[];
}

const ANNOUNCED_SPANS_MAX = 5;

let widgetSeq = 0;

const pending = (range: monaco.IRange) => ({
	range,
	options: {
		description: "presence-pending",
		isWholeLine: true,
		stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
	},
});

function badge(kind: "flag" | "chip", writer: PresenceWriter, text: string): HTMLElement {
	const node = document.createElement("div");
	node.className = `presence-${kind} presence-tone-${writer.tone}${writer.inferred ? " presence-inferred" : ""}`;
	node.dataset.presence = kind;
	node.dataset.writer = writer.id;
	node.setAttribute("aria-hidden", "true");
	node.textContent = text;
	return node;
}

export function attachPresence(
	codeEditor: monaco.editor.ICodeEditor,
	options: { text: () => PresenceText; announce(message: string): void },
) {
	let latest: PresenceWrite | undefined;
	const marks = new Set<Mark>();
	const writerOf = (hash: string) => (latest?.hash === hash ? latest.writer : undefined);

	const clearFlag = (mark: Mark) => {
		if (mark.flag) codeEditor.removeContentWidget(mark.flag);
		mark.flag = null;
	};
	const clearChip = (mark: Mark) => {
		if (mark.chip) codeEditor.removeOverlayWidget(mark.chip);
		mark.chip = null;
	};
	const drop = (mark: Mark) => {
		for (const timer of mark.timers) clearTimeout(timer);
		clearFlag(mark);
		clearChip(mark);
		mark.ranges.clear();
		marks.delete(mark);
	};

	const render = (mark: Mark, step: number) => {
		const writer = mark.writer;
		if (!writer || mark.paint.kind !== "lines") return;
		const washing = step < PRESENCE_TIMING.washSteps;
		const bar = `presence-bar presence-tone-${writer.tone}${writer.inferred ? " presence-inferred" : ""}`;
		const label = options.text().hover(writer);
		const hover = [
			{ value: markdownText(label) },
			...(mark.paint.diff.length > 0 ? [{ value: diffFence(mark.paint.diff) }] : []),
		];
		mark.ranges.set(
			mark.ranges.getRanges().map((range) => ({
				range,
				options: {
					description: "presence",
					isWholeLine: true,
					stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
					linesDecorationsClassName: bar,
					linesDecorationsTooltip: label,
					hoverMessage: hover,
					...(washing
						? { className: `presence-wash presence-wash-${step} presence-tone-${writer.tone}` }
						: {}),
				},
			})),
		);
	};

	const showFlag = (mark: Mark, writer: PresenceWriter) => {
		const at = mark.ranges.getRange(0)?.startLineNumber;
		for (const other of marks) {
			if (other !== mark && other.ranges.getRange(0)?.startLineNumber === at) clearFlag(other);
		}
		const node = badge("flag", writer, writer.label);
		const id = `presence-flag-${++widgetSeq}`;
		mark.flag = {
			getId: () => id,
			getDomNode: () => node,
			getPosition: () => {
				const model = codeEditor.getModel();
				const line = mark.ranges.getRange(0)?.startLineNumber;
				if (!model || line === undefined || line > model.getLineCount()) return null;
				return {
					position: { lineNumber: line, column: model.getLineMaxColumn(line) },
					preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
				};
			},
		};
		codeEditor.addContentWidget(mark.flag);
	};

	const showChip = (mark: Mark, writer: PresenceWriter) => {
		for (const other of marks) if (other !== mark && other.paint.kind === "file") drop(other);
		const node = badge("chip", writer, options.text().file(writer));
		const id = `presence-chip-${++widgetSeq}`;
		mark.chip = {
			getId: () => id,
			getDomNode: () => node,
			getPosition: () => ({
				preference: monaco.editor.OverlayWidgetPositionPreference.TOP_RIGHT_CORNER,
			}),
		};
		codeEditor.addOverlayWidget(mark.chip);
	};

	const absorb = (mark: Mark, writer: PresenceWriter) => {
		if (mark.paint.kind !== "lines") return;
		for (const other of [...marks]) {
			if (other === mark || other.writer?.id !== writer.id || other.paint.kind !== "lines")
				continue;
			const own = mark.ranges.getRanges();
			const covered = (range: monaco.IRange) =>
				own.some(
					(mine) =>
						mine.startLineNumber <= range.startLineNumber &&
						mine.endLineNumber >= range.endLineNumber,
				);
			mark.ranges.append(
				other.ranges
					.getRanges()
					.filter((range) => !covered(range))
					.map(pending),
			);
			mark.paint = { ...mark.paint, diff: joinDiffs(mark.paint.diff, other.paint.diff) };
			mark.announcedAt = Math.max(mark.announcedAt, other.announcedAt);
			drop(other);
		}
	};

	const paint = (mark: Mark, writer: PresenceWriter) => {
		for (const timer of mark.timers) clearTimeout(timer);
		const now = Date.now();
		mark.writer = writer;
		const text = options.text();
		if (mark.paint.kind === "file") {
			showChip(mark, writer);
			options.announce(text.file(writer));
			mark.timers = [setTimeout(() => drop(mark), PRESENCE_TIMING.chipMs)];
			return;
		}
		const spans = mark.ranges
			.getRanges()
			.map((range) => ({ startLine: range.startLineNumber, endLine: range.endLineNumber }));
		absorb(mark, writer);
		render(mark, 0);
		showFlag(mark, writer);
		if (spans.length > 0 && now - mark.announcedAt >= PRESENCE_TIMING.flagMs) {
			mark.announcedAt = now;
			options.announce(
				spans.length > ANNOUNCED_SPANS_MAX
					? text.places(writer, spans.length)
					: text.lines(writer, spans),
			);
		}
		const washStep = PRESENCE_TIMING.washMs / PRESENCE_TIMING.washSteps;
		mark.timers = [
			...Array.from({ length: PRESENCE_TIMING.washSteps }, (_, index) =>
				setTimeout(() => render(mark, index + 1), (index + 1) * washStep),
			),
			setTimeout(() => clearFlag(mark), PRESENCE_TIMING.flagMs),
			setTimeout(() => drop(mark), PRESENCE_TIMING.holdMs),
		];
	};

	return {
		land(landing: DiskLanding) {
			const result = presencePaint(landing);
			const model = codeEditor.getModel();
			if (!result || !model) return;
			const spans = result.kind === "lines" ? result.spans : [];
			const mark: Mark = {
				hash: landing.hash,
				paint: result,
				ranges: codeEditor.createDecorationsCollection(
					spans.map((span) =>
						pending({
							startLineNumber: span.startLine,
							startColumn: 1,
							endLineNumber: span.endLine,
							endColumn: model.getLineMaxColumn(Math.min(span.endLine, model.getLineCount())),
						}),
					),
				),
				writer: null,
				announcedAt: Number.NEGATIVE_INFINITY,
				flag: null,
				chip: null,
				timers: [],
			};
			marks.add(mark);
			const writer = writerOf(landing.hash);
			if (writer) paint(mark, writer);
			else mark.timers = [setTimeout(() => drop(mark), PRESENCE_TIMING.pendingMs)];
		},
		setLatest(next: PresenceWrite | undefined) {
			latest = next;
			for (const mark of [...marks]) {
				if (!marks.has(mark)) continue;
				const writer = mark.writer ? undefined : writerOf(mark.hash);
				if (writer) paint(mark, writer);
			}
		},
		dispose() {
			for (const mark of [...marks]) drop(mark);
		},
	};
}
