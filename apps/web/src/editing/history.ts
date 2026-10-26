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
import { refined, textChanges } from "./textChanges";

interface Hop {
	fromDoc: Text;
	changes: ChangeSet;
}

interface OpenConflict extends EditConflict {
	base?: string;
}

interface ConflictState {
	open: readonly OpenConflict[];
	closed: readonly OpenConflict[];
}

type MapMode = "remote" | "local" | "history";

const lineage = new WeakMap<EditorState, Hop>();

function endsOnOpenLastLine(conflict: EditConflict, doc: Text): boolean {
	return (
		conflict.to > conflict.from &&
		conflict.to === doc.length &&
		doc.sliceString(conflict.to - 1, conflict.to) !== "\n"
	);
}

function mapConflict<T extends EditConflict>(
	conflict: T,
	mapping: ChangeDesc,
	mode: MapMode = "remote",
	startDoc?: Text,
): T {
	const from = mapping.mapPos(conflict.from, mode === "remote" ? 1 : -1);
	const grows =
		(mode === "history" && conflict.from === conflict.to) ||
		(mode !== "remote" && startDoc !== undefined && endsOnOpenLastLine(conflict, startDoc));
	const to = Math.max(from, mapping.mapPos(conflict.to, grows ? 1 : -1));
	return from === conflict.from && to === conflict.to ? conflict : { ...conflict, from, to };
}

function mapConflicts(
	conflicts: readonly OpenConflict[],
	tr: Transaction,
	mode: MapMode,
): readonly OpenConflict[] {
	if (!tr.docChanged || conflicts.length === 0) return conflicts;
	const mapped = conflicts.map((conflict) =>
		mapConflict(conflict, tr.changes, mode, tr.startState.doc),
	);
	return mapped.every((conflict, index) => conflict === conflicts[index]) ? conflicts : mapped;
}

function mapMode(tr: Transaction): MapMode {
	if (tr.annotation(Transaction.remote) === true) return "remote";
	return tr.isUserEvent("undo") || tr.isUserEvent("redo") ? "history" : "local";
}

const addConflicts = StateEffect.define<readonly OpenConflict[]>({
	map: (conflicts, mapping) => conflicts.map((conflict) => mapConflict(conflict, mapping)),
});
const removeConflict = StateEffect.define<OpenConflict>({
	map: (conflict, mapping) => mapConflict(conflict, mapping),
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

const NO_CONFLICTS: ConflictState = { open: [], closed: [] };

const withoutId = (conflicts: readonly OpenConflict[], id: number) =>
	conflicts.filter((conflict) => conflict.id !== id);

const conflictField = StateField.define<ConflictState>({
	create: () => NO_CONFLICTS,
	update(value, tr) {
		const rebased = tr.effects.some((effect) => effect.is(newBase));
		const mode = mapMode(tr);
		let open = mapConflicts(value.open, tr, mode);
		let closed = mapConflicts(value.closed, tr, "remote");
		for (const effect of tr.effects) {
			if (effect.is(clearConflicts)) {
				open = [];
				closed = [];
			} else if (effect.is(removeConflict)) {
				open = withoutId(open, effect.value.id);
				closed = [...withoutId(closed, effect.value.id), effect.value];
			} else if (effect.is(newBase)) {
				const untouched = (conflict: OpenConflict) =>
					!effect.value.some((range) => touches(conflict, range));
				open = open.filter(untouched);
				closed = closed.filter(untouched);
			} else if (effect.is(addConflicts)) {
				const added = effect.value.filter(
					(conflict) => rebased || closed.some((other) => other.id === conflict.id),
				);
				if (added.length === 0) continue;
				closed = closed.filter((conflict) => !added.some((other) => other.id === conflict.id));
				open = [
					...open.filter((conflict) => !added.some((other) => overlaps(conflict, other))),
					...added,
				].sort((a, b) => a.from - b.from);
			}
		}
		return open === value.open && closed === value.closed ? value : { open, closed };
	},
});

const invertConflicts = invertedEffects.of((tr) => {
	const before = tr.startState.field(conflictField);
	return tr.effects.flatMap((effect): StateEffect<unknown>[] => {
		if (effect.is(removeConflict)) {
			const original = before.open.find((conflict) => conflict.id === effect.value.id);
			return original ? [addConflicts.of([original])] : [];
		}
		if (effect.is(addConflicts)) {
			return effect.value.map((conflict) =>
				removeConflict.of(before.closed.find((other) => other.id === conflict.id) ?? conflict),
			);
		}
		return [];
	});
});

const closeMatched = EditorState.transactionExtender.of((tr) => {
	if (!tr.docChanged || tr.annotation(Transaction.remote) === true) return null;
	const removed = new Set(
		tr.effects.flatMap((effect) => (effect.is(removeConflict) ? [effect.value.id] : [])),
	);
	const matched = mapConflicts(tr.startState.field(conflictField).open, tr, mapMode(tr)).filter(
		(conflict) =>
			!removed.has(conflict.id) &&
			tr.newDoc.sliceString(conflict.from, conflict.to) === conflict.theirs,
	);
	return matched.length > 0
		? { effects: matched.map((conflict) => removeConflict.of(conflict)) }
		: null;
});

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
			closeMatched,
			EditorState.allowMultipleSelections.of(true),
		],
	});
}

const docStrings = new WeakMap<Text, string>();

export function docText(doc: EditorState): string {
	let text = docStrings.get(doc.doc);
	if (text === undefined) {
		text = doc.doc.toString();
		docStrings.set(doc.doc, text);
	}
	return text;
}

export function docChanges(from: EditorState, to: EditorState): TextChange[] {
	if (from.doc === to.doc) return [];
	const hop = lineage.get(to);
	if (!hop || hop.fromDoc !== from.doc) throw new Error("Doc moved by more than one step");
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
	return state.open.length > 0 || state.closed.length > 0;
}

function changedRanges(changes: ChangeSet): MergeRange[] {
	const ranges: MergeRange[] = [];
	changes.iterChangedRanges((_fromA, _toA, from, to) => {
		ranges.push({ from, to });
	});
	return ranges;
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
	const changes = ChangeSet.of(input.changes ?? textChanges(current, input.text), current.length);
	const effects = [
		...(input.clear && hasConflictState(doc) ? [clearConflicts.of(null)] : []),
		newBase.of(input.touched ?? changedRanges(changes)),
		...(added.length > 0 ? [addConflicts.of(added)] : []),
	];
	return step(doc, {
		changes,
		effects,
		annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
	});
}

export function userText(doc: EditorState, text: string): EditorState {
	const current = docText(doc);
	if (current === text && !hasConflictState(doc)) return doc;
	return step(doc, {
		changes: textChanges(current, text),
		effects: clearConflicts.of(null),
		annotations: [Transaction.userEvent.of("input.replace"), isolateHistory.of("full")],
	});
}

function withNewline(doc: EditorState, conflict: EditConflict): string {
	const text = doc.sliceDoc(conflict.from, conflict.to);
	return text !== "" && !text.endsWith("\n") && conflict.to === doc.doc.length ? `${text}\n` : text;
}

function takeTheirsWhereReverted(doc: EditorState): EditorState {
	const reverted = conflictsOf(doc).filter(
		(conflict) => conflict.base !== undefined && withNewline(doc, conflict) === conflict.base,
	);
	if (reverted.length === 0) return doc;
	const text = docText(doc);
	const changes = ChangeSet.of(
		reverted.map((conflict) =>
			refined(text, { from: conflict.from, to: conflict.to, insert: conflict.theirs }),
		),
		doc.doc.length,
	);
	const tr = doc.update({
		changes,
		effects: reverted.map((conflict) =>
			removeConflict.of({
				...conflict,
				from: changes.mapPos(conflict.from, -1),
				to: changes.mapPos(conflict.to, 1),
			}),
		),
		annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
	});
	const hop = lineage.get(doc);
	lineage.set(
		tr.state,
		hop
			? { fromDoc: hop.fromDoc, changes: hop.changes.compose(tr.changes) }
			: { fromDoc: doc.doc, changes: tr.changes },
	);
	return tr.state;
}

function runCommand(doc: EditorState, command: typeof undo): EditorState {
	let next = doc;
	command({
		state: doc,
		dispatch: (tr) => {
			next = record(tr);
		},
	});
	return next === doc ? doc : takeTheirsWhereReverted(next);
}

export const undoDoc = (doc: EditorState) => runCommand(doc, undo);
export const redoDoc = (doc: EditorState) => runCommand(doc, redo);
export const canUndoDoc = (doc: EditorState) => undoDepth(doc) > 0;
export const canRedoDoc = (doc: EditorState) => redoDepth(doc) > 0;

export function conflictsOf(doc: EditorState): readonly OpenConflict[] {
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
		effects: removeConflict.of({ ...conflict, to: conflict.from + insert.length }),
		annotations: [Transaction.userEvent.of("input.resolve"), isolateHistory.of("full")],
	});
}
