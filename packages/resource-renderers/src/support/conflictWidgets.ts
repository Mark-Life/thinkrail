import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import type { EditConflict } from "../registry";
import { type ConflictSpan, sameConflictLayout } from "./conflictLayout";

const LENS_HEIGHT_PX = 36;

export interface ConflictZone {
	conflict: EditConflict;
	lens: HTMLElement;
	theirs: HTMLElement;
}

interface PlacedConflict extends ConflictZone, ConflictSpan {
	lensId: string;
	theirsId: string;
}

function lineSpan(model: monaco.editor.ITextModel, conflict: EditConflict) {
	return {
		startLine: model.getPositionAt(conflict.from).lineNumber,
		endLine: conflict.to > conflict.from ? model.getPositionAt(conflict.to - 1).lineNumber : null,
	};
}

function theirsLineCount(theirs: string): number {
	if (theirs === "") return 1;
	return theirs.split("\n").length - (theirs.endsWith("\n") ? 1 : 0);
}

function zoneNode(kind: "lens" | "theirs", lineHeight: number): HTMLElement {
	const node = document.createElement("div");
	node.className = "edit-conflict-zone";
	node.dataset.conflictZone = kind;
	node.style.setProperty("--edit-conflict-line-height", `${lineHeight}px`);
	return node;
}

export function attachConflictZones(
	codeEditor: monaco.editor.ICodeEditor,
	onZones: (zones: ConflictZone[]) => void,
) {
	let placed: PlacedConflict[] = [];
	const decorations = codeEditor.createDecorationsCollection();
	const lineHeight = () => codeEditor.getOption(monaco.editor.EditorOption.lineHeight);

	const place = (
		accessor: monaco.editor.IViewZoneChangeAccessor,
		conflict: EditConflict,
		span: ReturnType<typeof lineSpan>,
	): PlacedConflict => {
		const height = lineHeight();
		const lens = zoneNode("lens", height);
		const theirs = zoneNode("theirs", height);
		const lensId = accessor.addZone({
			afterLineNumber: span.startLine - 1,
			heightInPx: LENS_HEIGHT_PX,
			ordinal: 0,
			domNode: lens,
		});
		const theirsId = accessor.addZone({
			afterLineNumber: span.endLine ?? span.startLine - 1,
			heightInLines: theirsLineCount(conflict.theirs),
			ordinal: 1,
			domNode: theirs,
		});
		return { conflict, ...span, lens, theirs, lensId, theirsId };
	};

	const clear = (accessor: monaco.editor.IViewZoneChangeAccessor, entry: PlacedConflict) => {
		accessor.removeZone(entry.lensId);
		accessor.removeZone(entry.theirsId);
	};

	return {
		setConflicts(conflicts: readonly EditConflict[]) {
			const model = codeEditor.getModel();
			const next = model
				? conflicts.map((conflict) => ({ conflict, span: lineSpan(model, conflict) }))
				: [];
			if (sameConflictLayout(placed, next)) {
				placed = placed.map((entry, index) => ({
					...entry,
					conflict: next[index]?.conflict ?? entry.conflict,
				}));
				return;
			}
			codeEditor.changeViewZones((accessor) => {
				const kept = new Map<number, PlacedConflict>();
				for (const entry of placed) {
					const match = next.find(({ conflict }) => conflict.id === entry.conflict.id);
					if (
						match &&
						match.conflict.theirs === entry.conflict.theirs &&
						match.span.startLine === entry.startLine &&
						match.span.endLine === entry.endLine
					) {
						kept.set(entry.conflict.id, { ...entry, conflict: match.conflict });
					} else {
						clear(accessor, entry);
					}
				}
				placed = next.map(
					({ conflict, span }) => kept.get(conflict.id) ?? place(accessor, conflict, span),
				);
			});
			decorations.set(
				placed.flatMap((entry) =>
					entry.endLine === null
						? []
						: [
								{
									range: new monaco.Range(entry.startLine, 1, entry.endLine, 1),
									options: {
										isWholeLine: true,
										className: "edit-conflict-mine",
										linesDecorationsClassName: "edit-conflict-mine-rail",
									},
								},
							],
				),
			);
			onZones(placed.map(({ conflict, lens, theirs }) => ({ conflict, lens, theirs })));
		},
		dispose() {
			codeEditor.changeViewZones((accessor) => {
				for (const entry of placed) clear(accessor, entry);
			});
			placed = [];
			decorations.clear();
			onZones([]);
		},
	};
}
