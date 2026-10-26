import {
	historyField,
	invertedEffects,
	isolateHistory,
	redo,
	redoDepth,
	undo,
	undoDepth,
} from "@codemirror/commands";
import {
	type ChangeDesc,
	ChangeSet,
	EditorSelection,
	EditorState,
	StateEffect,
	StateField,
	Transaction,
	type TransactionSpec,
} from "@codemirror/state";
import type {
	ConflictChoice,
	EditConflict,
	LocalEditKind,
	TextChange,
	TextRange,
} from "@thinkrail/resource-renderers";
import type { MergeConflict } from "./merge3";
import { textChanges } from "./textChanges";

const lineage = new WeakMap<EditorState, { from: EditorState; changes: ChangeSet }>();

function mapConflict(conflict: EditConflict, mapping: ChangeDesc, remote: boolean): EditConflict {
	const from = mapping.mapPos(conflict.from, remote ? 1 : -1);
	return { ...conflict, from, to: Math.max(from, mapping.mapPos(conflict.to, -1)) };
}

const addConflicts = StateEffect.define<readonly EditConflict[]>({
	map: (conflicts, mapping) => conflicts.map((conflict) => mapConflict(conflict, mapping, true)),
});
const removeConflict = StateEffect.define<EditConflict>({
	map: (conflict, mapping) => mapConflict(conflict, mapping, true),
});
const clearConflicts = StateEffect.define<null>();

const overlaps = (a: EditConflict, b: EditConflict) =>
	a.from === b.from || (a.from < b.to && b.from < a.to);

const conflictField = StateField.define<readonly EditConflict[]>({
	create: () => [],
	update(value, tr) {
		const remote = tr.annotation(Transaction.remote) === true;
		let next =
			tr.docChanged && value.length > 0
				? value.map((conflict) => mapConflict(conflict, tr.changes, remote))
				: value;
		for (const effect of tr.effects) {
			if (effect.is(clearConflicts)) next = [];
			else if (effect.is(removeConflict)) {
				next = next.filter((conflict) => conflict.id !== effect.value.id);
			} else if (effect.is(addConflicts)) {
				next = [
					...next.filter((conflict) => !effect.value.some((added) => overlaps(conflict, added))),
					...effect.value,
				].sort((a, b) => a.from - b.from);
			}
		}
		return next;
	},
});

const invertConflicts = invertedEffects.of((tr) =>
	tr.effects.flatMap((effect): StateEffect<unknown>[] => {
		if (effect.is(removeConflict)) return [addConflicts.of([effect.value])];
		if (effect.is(addConflicts)) return effect.value.map((conflict) => removeConflict.of(conflict));
		return [];
	}),
);

let nextConflictId = 1;

function record(tr: Transaction): EditorState {
	lineage.set(tr.state, { from: tr.startState, changes: tr.changes });
	return tr.state;
}

function step(doc: EditorState, spec: TransactionSpec): EditorState {
	return record(doc.update(spec));
}

export function createDoc(text: string): EditorState {
	return EditorState.create({
		doc: text,
		extensions: [
			historyField,
			conflictField,
			invertConflicts,
			EditorState.allowMultipleSelections.of(true),
		],
	});
}

export function docText(doc: EditorState): string {
	return doc.doc.toString();
}

export function docChanges(from: EditorState, to: EditorState): TextChange[] | null {
	const chain: ChangeSet[] = [];
	let cursor = to;
	while (cursor !== from) {
		const link = lineage.get(cursor);
		if (!link) return null;
		chain.push(link.changes);
		cursor = link.from;
	}
	let composed = ChangeSet.empty(from.doc.length);
	for (const changes of chain.reverse()) composed = composed.compose(changes);
	const out: TextChange[] = [];
	composed.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
		out.push({ from: fromA, to: toA, insert: inserted.toString() });
	});
	return out;
}

const USER_EVENTS: Record<LocalEditKind, string> = {
	type: "input.type",
	delete: "delete",
	paste: "input.paste",
	composeStart: "input.type.compose.start",
	compose: "input.type.compose",
	other: "input",
};

export function localChange(
	doc: EditorState,
	changes: readonly TextChange[],
	kind: LocalEditKind,
): EditorState {
	if (changes.length === 0) return doc;
	return step(doc, {
		changes: ChangeSet.of(
			changes.map((change) => ({ from: change.from, to: change.to, insert: change.insert })),
			doc.doc.length,
		),
		annotations: Transaction.userEvent.of(USER_EVENTS[kind]),
	});
}

function toSelection(doc: EditorState, ranges: readonly TextRange[]): EditorSelection | null {
	const length = doc.doc.length;
	const clamp = (offset: number) => Math.max(0, Math.min(length, offset));
	if (ranges.length === 0) return null;
	return EditorSelection.create(
		ranges.map((range) => EditorSelection.range(clamp(range.anchor), clamp(range.head))),
	);
}

export function selectDoc(doc: EditorState, ranges: readonly TextRange[]): EditorState {
	const selection = toSelection(doc, ranges);
	if (!selection || selection.eq(doc.selection)) return doc;
	return step(doc, { selection, annotations: Transaction.addToHistory.of(false) });
}

export function docSelection(doc: EditorState): TextRange[] {
	return doc.selection.ranges.map((range) => ({ anchor: range.anchor, head: range.head }));
}

export function remoteText(
	doc: EditorState,
	text: string,
	conflicts: { add?: readonly MergeConflict[]; clear?: boolean } = {},
): EditorState {
	const current = docText(doc);
	const added = (conflicts.add ?? []).map((conflict) => ({ ...conflict, id: nextConflictId++ }));
	const effects = [
		...(conflicts.clear && conflictsOf(doc).length > 0 ? [clearConflicts.of(null)] : []),
		...(added.length > 0 ? [addConflicts.of(added)] : []),
	];
	if (current === text && effects.length === 0) return doc;
	return step(doc, {
		changes: textChanges(current, text),
		effects,
		annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
	});
}

export function userText(doc: EditorState, text: string): EditorState {
	const current = docText(doc);
	if (current === text && conflictsOf(doc).length === 0) return doc;
	return step(doc, {
		changes: textChanges(current, text),
		effects: conflictsOf(doc).map((conflict) => removeConflict.of(conflict)),
		annotations: [Transaction.userEvent.of("input.replace"), isolateHistory.of("full")],
	});
}

function runCommand(doc: EditorState, command: typeof undo): EditorState {
	let next = doc;
	command({
		state: doc,
		dispatch: (tr) => {
			next = record(tr);
		},
	});
	return next;
}

export const undoDoc = (doc: EditorState) => runCommand(doc, undo);
export const redoDoc = (doc: EditorState) => runCommand(doc, redo);
export const canUndoDoc = (doc: EditorState) => undoDepth(doc) > 0;
export const canRedoDoc = (doc: EditorState) => redoDepth(doc) > 0;

export function conflictsOf(doc: EditorState): readonly EditConflict[] {
	return doc.field(conflictField);
}

function joined(mine: string, theirs: string): string {
	return mine === "" || mine.endsWith("\n") || theirs === "" ? mine + theirs : `${mine}\n${theirs}`;
}

export function resolveDocConflict(
	doc: EditorState,
	id: number,
	choice: ConflictChoice,
): EditorState {
	const conflict = conflictsOf(doc).find((candidate) => candidate.id === id);
	if (!conflict) return doc;
	const mine = doc.sliceDoc(conflict.from, conflict.to);
	const insert =
		choice === "mine"
			? mine
			: choice === "theirs"
				? conflict.theirs
				: joined(mine, conflict.theirs);
	return step(doc, {
		...(insert === mine ? {} : { changes: { from: conflict.from, to: conflict.to, insert } }),
		effects: removeConflict.of(conflict),
		selection: { anchor: conflict.from + insert.length },
		annotations: [Transaction.userEvent.of("input.resolve"), isolateHistory.of("full")],
	});
}
