import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import {
	createPresenceMarks,
	type PresenceLook,
	type PresenceOptions,
	type PresenceRanges,
	type PresenceSurface,
	presenceClasses,
} from "./presenceCore";
import { diffFence, markdownText, PRESENCE_TIMING, type PresenceSpan } from "./presenceDecorations";
import { presenceKindIcon } from "./presenceIcons";

let widgetSeq = 0;

const pending = (range: monaco.IRange) => ({
	range,
	options: {
		description: "presence-pending",
		isWholeLine: true,
		stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
	},
});

function monacoSurface(codeEditor: monaco.editor.ICodeEditor): PresenceSurface {
	const lineRange = (model: monaco.editor.ITextModel, span: PresenceSpan): monaco.IRange => ({
		startLineNumber: span.startLine,
		startColumn: 1,
		endLineNumber: span.endLine,
		endColumn: model.getLineMaxColumn(Math.min(span.endLine, model.getLineCount())),
	});
	const ranges = new WeakMap<PresenceRanges, monaco.editor.IEditorDecorationsCollection>();
	return {
		track(spans) {
			const model = codeEditor.getModel();
			if (!model) return null;
			const collection = codeEditor.createDecorationsCollection(
				spans.map((span) => pending(lineRange(model, span))),
			);
			const tracked: PresenceRanges = {
				spans: () =>
					collection
						.getRanges()
						.map((range) => ({ startLine: range.startLineNumber, endLine: range.endLineNumber })),
				paint: (look: PresenceLook) => {
					const washing = look.step < PRESENCE_TIMING.washSteps;
					const hover = [
						{ value: markdownText(look.label) },
						...(look.diff.length > 0 ? [{ value: diffFence(look.diff) }] : []),
					];
					collection.set(
						collection.getRanges().map((range) => ({
							range,
							options: {
								description: "presence",
								isWholeLine: true,
								stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
								linesDecorationsClassName: `presence-bar ${presenceClasses(look.writer)}`,
								linesDecorationsTooltip: look.label,
								hoverMessage: hover,
								...(washing
									? {
											className: `presence-wash presence-wash-${look.step} presence-tone-${look.writer.tone}`,
										}
									: {}),
							},
						})),
					);
				},
				append: (more) => {
					const current = codeEditor.getModel();
					if (current) collection.append(more.map((span) => pending(lineRange(current, span))));
				},
				set: (spans) => {
					const current = codeEditor.getModel();
					if (current) collection.set(spans.map((span) => pending(lineRange(current, span))));
				},
				clear: () => collection.clear(),
			};
			ranges.set(tracked, collection);
			return tracked;
		},
		flag(tracked, node) {
			const collection = ranges.get(tracked);
			const id = `presence-flag-${++widgetSeq}`;
			const widget: monaco.editor.IContentWidget = {
				getId: () => id,
				getDomNode: () => node,
				getPosition: () => {
					const model = codeEditor.getModel();
					const line = collection?.getRange(0)?.startLineNumber;
					if (!model || line === undefined || line > model.getLineCount()) return null;
					return {
						position: { lineNumber: line, column: model.getLineMaxColumn(line) },
						preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
					};
				},
			};
			codeEditor.addContentWidget(widget);
			return () => codeEditor.removeContentWidget(widget);
		},
		chip(node) {
			const id = `presence-chip-${++widgetSeq}`;
			const widget: monaco.editor.IOverlayWidget = {
				getId: () => id,
				getDomNode: () => node,
				getPosition: () => ({
					preference: monaco.editor.OverlayWidgetPositionPreference.TOP_RIGHT_CORNER,
				}),
			};
			codeEditor.addOverlayWidget(widget);
			return () => codeEditor.removeOverlayWidget(widget);
		},
	};
}

export function attachPresence(
	codeEditor: monaco.editor.ICodeEditor,
	options: Omit<PresenceOptions, "icon">,
) {
	return createPresenceMarks(monacoSurface(codeEditor), { ...options, icon: presenceKindIcon });
}
