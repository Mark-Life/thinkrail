import type { editor } from "monaco-editor/editor/editor.api.js";
import * as monaco from "monaco-editor/editor/editor.api.js";
import type {
	EditConflict,
	EditUpdate,
	LocalEditKind,
	ResourceEditSession,
	TextChange,
	TextRange,
} from "../registry";

type Composition = "idle" | "start" | "active";

function editKind(
	changes: readonly editor.IModelContentChange[],
	composition: Composition,
	pasting: boolean,
): LocalEditKind {
	if (composition === "start") return "composeStart";
	if (composition === "active") return "compose";
	if (pasting) return "paste";
	if (changes.every((change) => change.text === "")) return "delete";
	const typed = changes.every(
		(change) =>
			change.text !== "" &&
			!change.text.includes("\n") &&
			(change.rangeLength === 0 || change.text.length === 1),
	);
	return typed ? "type" : "other";
}

function toRange(model: editor.ITextModel, change: TextChange): monaco.IRange {
	const start = model.getPositionAt(change.from);
	const end = model.getPositionAt(change.to);
	return {
		startLineNumber: start.lineNumber,
		startColumn: start.column,
		endLineNumber: end.lineNumber,
		endColumn: end.column,
	};
}

function toSelection(model: editor.ITextModel, range: TextRange): monaco.Selection {
	const anchor = model.getPositionAt(range.anchor);
	const head = model.getPositionAt(range.head);
	return new monaco.Selection(anchor.lineNumber, anchor.column, head.lineNumber, head.column);
}

function selectionRanges(model: editor.ITextModel, selections: readonly monaco.Selection[]) {
	return selections.map((selection) => ({
		anchor: model.getOffsetAt(selection.getSelectionStart()),
		head: model.getOffsetAt(selection.getPosition()),
	}));
}

export function mirrorEditSession(
	codeEditor: editor.IStandaloneCodeEditor,
	model: editor.ITextModel,
	session: ResourceEditSession,
	onConflicts: (conflicts: readonly EditConflict[]) => void,
) {
	let applying = false;
	let composition: Composition = "idle";
	let pasting = false;
	let pasteTimer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;
	let conflicts: readonly EditConflict[] | null = null;

	const reportConflicts = () => {
		const next = session.conflicts();
		if (next === conflicts) return;
		conflicts = next;
		onConflicts(next);
	};

	const original = {
		undo: model.undo,
		redo: model.redo,
		canUndo: model.canUndo,
		canRedo: model.canRedo,
	};
	model.undo = () => session.undo();
	model.redo = () => session.redo();
	model.canUndo = () => session.canUndo();
	model.canRedo = () => session.canRedo();

	const apply = (update: EditUpdate) => {
		if (model.isDisposed()) return;
		applying = true;
		try {
			if (update.changes.length > 0) {
				model.applyEdits(
					update.changes.map((change) => ({ range: toRange(model, change), text: change.insert })),
				);
			}
			const [first, ...rest] = update.selection ?? [];
			if (first && codeEditor.getModel() === model) {
				codeEditor.setSelections([first, ...rest].map((range) => toSelection(model, range)));
				codeEditor.revealPositionInCenterIfOutsideViewport(
					model.getPositionAt(first.head),
					monaco.editor.ScrollType.Smooth,
				);
			}
		} finally {
			applying = false;
		}
		reportConflicts();
	};

	const subscriptions = [
		model.onDidChangeContent((event) => {
			if (applying || event.isEolChange) return;
			session.applyLocal(
				event.changes.map((change) => ({
					from: change.rangeOffset,
					to: change.rangeOffset + change.rangeLength,
					insert: change.text,
				})),
				editKind(event.changes, composition, pasting),
			);
			pasting = false;
			if (composition === "start") composition = "active";
			reportConflicts();
		}),
		codeEditor.onDidChangeCursorSelection(() => {
			const selections = codeEditor.getSelections();
			if (applying || codeEditor.getModel() !== model || !selections) return;
			session.select(selectionRanges(model, selections));
		}),
		codeEditor.onDidCompositionStart(() => {
			composition = "start";
			session.setComposing(true);
		}),
		codeEditor.onDidCompositionEnd(() => {
			composition = "idle";
			session.setComposing(false);
		}),
	];

	const domNode = codeEditor.getDomNode();
	const onPaste = () => {
		pasting = true;
		if (pasteTimer !== null) clearTimeout(pasteTimer);
		pasteTimer = setTimeout(() => {
			pasting = false;
			pasteTimer = null;
		});
	};
	const onBeforeInput = (event: InputEvent) => {
		if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") return;
		if (!codeEditor.hasTextFocus()) return;
		event.preventDefault();
		if (event.inputType === "historyUndo") session.undo();
		else session.redo();
	};
	domNode?.addEventListener("paste", onPaste, true);
	domNode?.addEventListener("beforeinput", onBeforeInput, true);
	const unsubscribe = session.subscribe(apply);
	reportConflicts();

	return {
		dispose() {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			for (const subscription of subscriptions) subscription.dispose();
			domNode?.removeEventListener("paste", onPaste, true);
			if (pasteTimer !== null) clearTimeout(pasteTimer);
			domNode?.removeEventListener("beforeinput", onBeforeInput, true);
			if (composition !== "idle") session.setComposing(false);
			Object.assign(model, original);
			onConflicts([]);
		},
	};
}
