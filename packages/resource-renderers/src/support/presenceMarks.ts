import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import type { PresenceWrite, PresenceWriter } from "../registry";
import type { DiskLanding } from "./monacoMirror";
import {
	diffFence,
	htmlAttribute,
	markdownText,
	PRESENCE_TIMING,
	type PresencePaint,
	presencePaint,
	presencePhase,
} from "./presenceDecorations";

export interface PresenceText {
	hover(writer: PresenceWriter): string;
	lines(writer: PresenceWriter, startLine: number, endLine: number): string;
	file(writer: PresenceWriter): string;
}

interface Mark {
	hash: string;
	paint: PresencePaint;
	ranges: monaco.editor.IEditorDecorationsCollection;
	writer: PresenceWriter | null;
	paintedAt: number;
	flag: monaco.editor.IContentWidget | null;
	chip: monaco.editor.IOverlayWidget | null;
	timers: ReturnType<typeof setTimeout>[];
}

let widgetSeq = 0;

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
	let writes = new Map<string, PresenceWriter>();
	const marks = new Set<Mark>();

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

	const render = (mark: Mark) => {
		const writer = mark.writer;
		if (!writer || mark.paint.kind !== "lines") return;
		const phase = presencePhase(mark.paintedAt, Date.now());
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
					linesDecorationsTooltip: htmlAttribute(label),
					hoverMessage: hover,
					...(phase.wash ? { className: `presence-wash presence-tone-${writer.tone}` } : {}),
				},
			})),
		);
	};

	const showFlag = (mark: Mark, writer: PresenceWriter) => {
		if (writer.tone === "user" || mark.paint.kind !== "lines") return;
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

	const paint = (mark: Mark, writer: PresenceWriter) => {
		mark.writer = writer;
		mark.paintedAt = Date.now();
		for (const timer of mark.timers) clearTimeout(timer);
		const text = options.text();
		if (mark.paint.kind === "file") {
			showChip(mark, writer);
			options.announce(text.file(writer));
			mark.timers = [setTimeout(() => drop(mark), PRESENCE_TIMING.chipMs)];
			return;
		}
		render(mark);
		showFlag(mark, writer);
		const first = mark.ranges.getRange(0);
		if (first) options.announce(text.lines(writer, first.startLineNumber, first.endLineNumber));
		mark.timers = [
			setTimeout(() => render(mark), PRESENCE_TIMING.washMs),
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
					spans.map((span) => ({
						range: {
							startLineNumber: span.startLine,
							startColumn: 1,
							endLineNumber: span.endLine,
							endColumn: model.getLineMaxColumn(Math.min(span.endLine, model.getLineCount())),
						},
						options: {
							description: "presence-pending",
							isWholeLine: true,
							stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
						},
					})),
				),
				writer: null,
				paintedAt: 0,
				flag: null,
				chip: null,
				timers: [],
			};
			marks.add(mark);
			const writer = writes.get(landing.hash);
			if (writer) paint(mark, writer);
			else mark.timers = [setTimeout(() => drop(mark), PRESENCE_TIMING.pendingMs)];
		},
		setWrites(next: readonly PresenceWrite[]) {
			writes = new Map(next.map((write) => [write.hash, write.writer]));
			for (const mark of marks) {
				const writer = mark.writer ? null : writes.get(mark.hash);
				if (writer) paint(mark, writer);
			}
		},
		dispose() {
			for (const mark of [...marks]) drop(mark);
		},
	};
}
