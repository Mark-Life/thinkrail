import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import type { EditConflict } from "../registry";
import { type ConflictSpan, planConflictZones } from "./conflictLayout";

const LENS_HEIGHT_PX = 36;

export interface ConflictZone {
	conflict: EditConflict;
	lens: HTMLElement;
	theirs: HTMLElement;
}

interface PlacedConflict extends ConflictZone, ConflictSpan {
	lensId: string;
	theirsId: string;
	theirsZone: monaco.editor.IViewZone;
}

function lineSpan(model: monaco.editor.ITextModel, conflict: EditConflict) {
	const start = model.getPositionAt(conflict.from);
	const startsOnBreak =
		conflict.to === model.getValueLength() &&
		model.getPositionAt(conflict.to).column > 1 &&
		start.column === model.getLineMaxColumn(start.lineNumber) &&
		conflict.to > conflict.from + 1;
	return {
		startLine: startsOnBreak ? start.lineNumber + 1 : start.lineNumber,
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
	let disposed = false;
	let layoutFrame: number | null = null;
	const decorations = codeEditor.createDecorationsCollection();
	const lineHeight = () => codeEditor.getOption(monaco.editor.EditorOption.lineHeight);

	const fitTheirs = () => {
		codeEditor.changeViewZones((accessor) => {
			for (const entry of placed) {
				const height = entry.theirs.offsetHeight;
				if (height > 0 && entry.theirsZone.heightInPx !== height) {
					entry.theirsZone.heightInPx = height;
					accessor.layoutZone(entry.theirsId);
				}
			}
		});
	};
	const sizeObserver = new ResizeObserver(() => relayout());
	let observed = new Set<HTMLElement>();
	const observeTheirs = () => {
		const targets = new Set(placed.map((entry) => entry.theirs));
		if (targets.size === observed.size && [...targets].every((target) => observed.has(target))) {
			return;
		}
		sizeObserver.disconnect();
		observed = targets;
		for (const target of targets) sizeObserver.observe(target);
	};
	const relayout = () => {
		if (layoutFrame !== null || disposed) return;
		layoutFrame = requestAnimationFrame(() => {
			layoutFrame = null;
			if (disposed) return;
			observeTheirs();
			fitTheirs();
		});
	};

	const place = (
		accessor: monaco.editor.IViewZoneChangeAccessor,
		conflict: EditConflict,
		span: ReturnType<typeof lineSpan>,
	): PlacedConflict => {
		const height = lineHeight();
		const lens = zoneNode("lens", height);
		const theirsHolder = zoneNode("theirs", height);
		const theirs = theirsHolder.appendChild(document.createElement("div"));
		const lensId = accessor.addZone({
			afterLineNumber: span.startLine - 1,
			heightInPx: LENS_HEIGHT_PX,
			ordinal: 0,
			domNode: lens,
		});
		const theirsZone: monaco.editor.IViewZone = {
			afterLineNumber: span.endLine ?? span.startLine - 1,
			heightInLines: theirsLineCount(conflict.theirs),
			ordinal: 1,
			domNode: theirsHolder,
		};
		const theirsId = accessor.addZone(theirsZone);
		return { conflict, ...span, lens, theirs, lensId, theirsId, theirsZone };
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
			const plan = planConflictZones(placed, next);
			if (plan.unchanged) {
				placed = placed.map((entry) => plan.kept.get(entry.conflict.id) ?? entry);
				return;
			}
			codeEditor.changeViewZones((accessor) => {
				for (const entry of plan.removed) clear(accessor, entry);
				placed = next.map(
					({ conflict, span }) => plan.kept.get(conflict.id) ?? place(accessor, conflict, span),
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
			relayout();
		},
		dispose() {
			disposed = true;
			if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
			sizeObserver.disconnect();
			codeEditor.changeViewZones((accessor) => {
				for (const entry of placed) clear(accessor, entry);
			});
			placed = [];
			decorations.clear();
			onZones([]);
		},
	};
}
