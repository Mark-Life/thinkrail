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
	type Text,
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
import type { MergeConflict, MergeRange } from "./merge3";
import { textChanges } from "./textChanges";

interface Hop {
	fromDoc: Text;
	changes: ChangeSet;
}

interface ConflictState {
	open: readonly EditConflict[];
	reopenable: ReadonlySet<number>;
}

const lineage = new WeakMap<EditorState, Hop>();

function mapConflict(conflict: EditConflict, mapping: ChangeDesc, remote: boolean): EditConflict {
	const from = mapping.mapPos(conflict.from, remote ? 1 : -1);
	const to = Math.max(from, mapping.mapPos(conflict.to, -1));
	return from === conflict.from && to === conflict.to ? conflict : { ...conflict, from, to };
}

function mapConflicts(
	conflicts: readonly EditConflict[],
	mapping: ChangeDesc,
	remote: boolean,
): readonly EditConflict[] {
	const mapped = conflicts.map((conflict) => mapConflict(conflict, mapping, remote));
	return mapped.every((conflict, index) => conflict === conflicts[index]) ? conflicts : mapped;
}

const addConflicts = StateEffect.define<readonly EditConflict[]>({
	map: (conflicts, mapping) => conflicts.map((conflict) => mapConflict(conflict, mapping, true)),
});
const removeConflict = StateEffect.define<EditConflict>({
	map: (conflict, mapping) => mapConflict(conflict, mapping, true),
});
const clearConflicts = StateEffect.define<null>();
const newBase = StateEffect.define<readonly MergeRange[]>();

const overlaps = (a: EditConflict, b: EditConflict) =>
	a.from === b.from || (a.from < b.to && b.from < a.to);

function touches(conflict: EditConflict, range: MergeRange): boolean {
	const emptyConflict = conflict.from === conflict.to;
	const emptyRange = range.from === range.to;
	if (emptyConflict && emptyRange) return conflict.from === range.from;
	if (emptyConflict) return range.from < conflict.from && conflict.from < range.to;
	if (emptyRange) return conflict.from < range.from && range.from < conflict.to;
	return conflict.from < range.to && range.from < conflict.to;
}

const NO_CONFLICTS: ConflictState = { open: [], reopenable: new Set() };

const conflictField = StateField.define<ConflictState>({
	create: () => NO_CONFLICTS,
	update(value, tr) {
		const remote = tr.annotation(Transaction.remote) === true;
		const rebased = tr.effects.some((effect) => effect.is(newBase));
		let open =
			tr.docChanged && value.open.length > 0
				? mapConflicts(value.open, tr.changes, remote)
				: value.open;
		for (const effect of tr.effects) {
			if (effect.is(clearConflicts)) open = [];
			else if (effect.is(removeConflict)) {
				open = open.filter((conflict) => conflict.id !== effect.value.id);
			} else if (effect.is(newBase)) {
				const touched = effect.value;
				open = open.filter((conflict) => !touched.some((range) => touches(conflict, range)));
			} else if (effect.is(addConflicts)) {
				const added = effect.value.filter(
					(conflict) => rebased || value.reopenable.has(conflict.id),
				);
				if (added.length === 0) continue;
				open = [
					...open.filter((conflict) => !added.some((other) => overlaps(conflict, other))),
					...added,
				].sort((a, b) => a.from - b.from);
			}
		}
		const reopenable = rebased ? new Set(open.map((conflict) => conflict.id)) : value.reopenable;
		return open === value.open && reopenable === value.reopenable ? value : { open, reopenable };
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
	const carried = tr.docChanged ? null : lineage.get(tr.startState);
	lineage.set(tr.state, carried ?? { fromDoc: tr.startState.doc, changes: tr.changes });
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
	if (from.doc === to.doc) return [];
	const hop = lineage.get(to);
	if (!hop || hop.fromDoc !== from.doc) return null;
	const out: TextChange[] = [];
	hop.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
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

function hasConflictState(doc: EditorState): boolean {
	const state = doc.field(conflictField);
	return state.open.length > 0 || state.reopenable.size > 0;
}

export function remoteText(
	doc: EditorState,
	input: {
		text: string;
		changes?: readonly TextChange[];
		add?: readonly MergeConflict[];
		touched?: readonly MergeRange[];
		clear?: boolean;
	},
): EditorState {
	const current = docText(doc);
	const added = (input.add ?? []).map((conflict) => ({ ...conflict, id: nextConflictId++ }));
	if (current === input.text && added.length === 0 && !hasConflictState(doc)) return doc;
	const effects = [
		...(input.clear && conflictsOf(doc).length > 0 ? [clearConflicts.of(null)] : []),
		newBase.of(input.touched ?? []),
		...(added.length > 0 ? [addConflicts.of(added)] : []),
	];
	return step(doc, {
		changes: input.changes ?? textChanges(current, input.text),
		effects,
		annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
	});
}

export function userText(doc: EditorState, text: string): EditorState {
	const current = docText(doc);
	if (current === text && !hasConflictState(doc)) return doc;
	return step(doc, {
		changes: textChanges(current, text),
		effects: [...conflictsOf(doc).map((conflict) => removeConflict.of(conflict)), newBase.of([])],
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
	return doc.field(conflictField).open;
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
