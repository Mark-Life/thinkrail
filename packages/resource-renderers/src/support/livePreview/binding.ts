import {
	EditorSelection,
	type EditorState,
	Transaction,
	type TransactionSpec,
} from "@codemirror/state";
import type {
	EditConflict,
	EditUpdate,
	LocalEditKind,
	ResourceEditSession,
	TextChange,
	TextRange,
} from "../../registry";
import { type Composition, classifyEdit } from "../editKind";
import type { DiskLanding } from "../presenceCore";

interface BindableView {
	readonly state: EditorState;
	update(transactions: readonly Transaction[]): void;
	dispatch(spec: TransactionSpec): void;
}

function localChanges(tr: Transaction): TextChange[] {
	const changes: TextChange[] = [];
	tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
		changes.push({ from, to, insert: inserted.toString() });
	});
	return changes;
}

export function localEditKind(
	tr: Transaction,
	changes: readonly TextChange[],
	composition: Composition,
): LocalEditKind {
	const composing = tr.isUserEvent("input.type.compose");
	return classifyEdit(changes, {
		composition: composing ? (composition === "active" ? "active" : "start") : "idle",
		paste: tr.isUserEvent("input.paste"),
		typing: tr.isUserEvent("input.type"),
	});
}

function selectionRanges(state: EditorState): TextRange[] {
	return state.selection.ranges.map((range) => ({ anchor: range.anchor, head: range.head }));
}

export function remoteSpec(update: EditUpdate): TransactionSpec {
	const [first, ...rest] = update.selection ?? [];
	return {
		changes: update.changes.map((change) => ({ ...change })),
		...(first
			? {
					selection: EditorSelection.create(
						[first, ...rest].map((range) => EditorSelection.range(range.anchor, range.head)),
					),
					scrollIntoView: true,
				}
			: {}),
		annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
	};
}

export function bindSession(
	view: BindableView,
	session: ResourceEditSession,
	hooks: {
		onConflicts(conflicts: readonly EditConflict[]): void;
		onDisk(landing: DiskLanding): void;
	},
) {
	let composition: Composition = "idle";
	let conflicts: readonly EditConflict[] | null = null;
	let disposed = false;

	const reportConflicts = () => {
		const next = session.conflicts();
		if (next === conflicts) return;
		conflicts = next;
		hooks.onConflicts(next);
	};

	const apply = (update: EditUpdate) => {
		if (disposed) return;
		const before = update.disk ? view.state.doc.toString() : null;
		view.dispatch(remoteSpec(update));
		if (update.disk && before !== null) {
			hooks.onDisk({ hash: update.disk.hash, before, changes: update.changes });
		}
		reportConflicts();
	};

	const unsubscribe = session.subscribe(apply);
	reportConflicts();

	return {
		dispatch(transactions: readonly Transaction[]) {
			view.update(transactions);
			if (disposed) return;
			let local = false;
			for (const tr of transactions) {
				if (tr.annotation(Transaction.remote)) continue;
				if (!tr.changes.empty) {
					const changes = localChanges(tr);
					session.applyLocal(changes, localEditKind(tr, changes, composition));
					if (composition === "start") composition = "active";
					local = true;
				} else if (tr.selection) local = true;
			}
			if (!local) return;
			session.select(selectionRanges(view.state));
			reportConflicts();
		},
		compositionStart() {
			composition = "start";
			session.setComposing(true);
		},
		compositionEnd() {
			if (composition === "idle") return;
			composition = "idle";
			session.setComposing(false);
		},
		undo() {
			session.undo();
		},
		redo() {
			session.redo();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			if (composition !== "idle") session.setComposing(false);
			hooks.onConflicts([]);
		},
	};
}

export type SessionBinding = ReturnType<typeof bindSession>;
