import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import type {
	EditConflict,
	EditUpdate,
	LocalEditKind,
	ResourceEditSession,
	TextChange,
	TextRange,
} from "../../registry";
import type { DiskLanding } from "../presenceCore";
import { bindSession, localEditKind, remoteSpec, type SessionBinding } from "./binding";

function applyChanges(text: string, changes: readonly TextChange[]) {
	let out = "";
	let cursor = 0;
	for (const change of changes) {
		out += text.slice(cursor, change.from) + change.insert;
		cursor = change.to;
	}
	return out + text.slice(cursor);
}

function fakeSession(initial: string) {
	let text = initial;
	let conflicts: readonly EditConflict[] = [];
	const listeners = new Set<(update: EditUpdate) => void>();
	const log = {
		local: [] as { changes: readonly TextChange[]; kind: LocalEditKind }[],
		selections: [] as (readonly TextRange[])[],
		composing: [] as boolean[],
		undo: 0,
		redo: 0,
	};
	const session: ResourceEditSession = {
		snapshot: () => text,
		applyLocal(changes, kind) {
			text = applyChanges(text, changes);
			log.local.push({ changes, kind });
		},
		select: (ranges) => log.selections.push(ranges),
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		undo: () => {
			log.undo += 1;
		},
		redo: () => {
			log.redo += 1;
		},
		canUndo: () => false,
		canRedo: () => false,
		setComposing: (composing) => log.composing.push(composing),
		conflicts: () => conflicts,
		resolveConflict() {},
	};
	return {
		session,
		log,
		text: () => text,
		emit(update: EditUpdate) {
			text = applyChanges(text, update.changes);
			for (const listener of listeners) listener(update);
		},
		setConflicts(next: readonly EditConflict[]) {
			conflicts = next;
		},
		listeners,
	};
}

function mount(initial: string) {
	const fake = fakeSession(initial);
	const reported: (readonly EditConflict[])[] = [];
	const landed: DiskLanding[] = [];
	const transactions: Transaction[] = [];
	let binding: SessionBinding | null = null;
	const view = {
		state: EditorState.create({ doc: fake.session.snapshot() }),
		update(trs: readonly Transaction[]) {
			transactions.push(...trs);
			const last = trs.at(-1);
			if (last) view.state = last.state;
		},
		dispatch(spec: TransactionSpec) {
			const tr = view.state.update(spec);
			if (binding) binding.dispatch([tr]);
			else view.update([tr]);
		},
	};
	binding = bindSession(view, fake.session, {
		onConflicts: (conflicts) => reported.push(conflicts),
		onDisk: (landing) => landed.push(landing),
	});
	return { fake, view, binding, reported, landed, transactions };
}

describe("localEditKind", () => {
	const state = EditorState.create({ doc: "abc\ndef" });
	const kind = (spec: TransactionSpec, composition: "idle" | "start" | "active" = "idle") => {
		const tr = state.update(spec);
		const changes: TextChange[] = [];
		tr.changes.iterChanges((from, to, _a, _b, inserted) =>
			changes.push({ from, to, insert: inserted.toString() }),
		);
		return localEditKind(tr, changes, composition);
	};
	test("names typing, deletes, pastes, compositions and the rest", () => {
		expect(kind({ changes: { from: 1, insert: "x" }, userEvent: "input.type" })).toBe("type");
		expect(kind({ changes: { from: 1, to: 2, insert: "x" }, userEvent: "input.type" })).toBe(
			"type",
		);
		expect(kind({ changes: { from: 1, to: 3, insert: "xy" }, userEvent: "input.type" })).toBe(
			"other",
		);
		expect(kind({ changes: { from: 1, insert: "\n" }, userEvent: "input" })).toBe("other");
		expect(kind({ changes: { from: 1, insert: "\n" }, userEvent: "input.type" })).toBe("other");
		expect(kind({ changes: { from: 0, to: 1 }, userEvent: "delete.backward" })).toBe("delete");
		expect(kind({ changes: { from: 0, insert: "a\nb" }, userEvent: "input.paste" })).toBe("paste");
		expect(
			kind({ changes: { from: 0, insert: "か" }, userEvent: "input.type.compose" }, "start"),
		).toBe("composeStart");
		expect(
			kind({ changes: { from: 0, insert: "か" }, userEvent: "input.type.compose" }, "active"),
		).toBe("compose");
	});
});

describe("remoteSpec", () => {
	test("lands as a remote step outside the history, with the selection it carries", () => {
		const state = EditorState.create({ doc: "one\ntwo\n" });
		const tr = state.update(
			remoteSpec({
				changes: [{ from: 4, to: 7, insert: "TWO" }],
				selection: [{ anchor: 1, head: 2 }],
			}),
		);
		expect(tr.state.doc.toString()).toBe("one\nTWO\n");
		expect(tr.annotation(Transaction.remote)).toBe(true);
		expect(tr.annotation(Transaction.addToHistory)).toBe(false);
		expect(tr.state.selection.main).toMatchObject({ anchor: 1, head: 2 });
		expect(tr.scrollIntoView).toBe(true);
	});
	test("without a selection the cursor maps through the change", () => {
		const state = EditorState.create({ doc: "one\ntwo", selection: { anchor: 6 } });
		const tr = state.update(remoteSpec({ changes: [{ from: 0, to: 0, insert: "zero\n" }] }));
		expect(tr.state.selection.main.head).toBe(11);
		expect(tr.scrollIntoView).toBe(false);
	});
});

describe("bindSession", () => {
	test("opening and moving the cursor sends no edit, so a save writes the bytes it read", () => {
		const { fake, view } = mount("# Title\r\n".replace("\r\n", "\n"));
		view.dispatch({ selection: EditorSelection.cursor(3) });
		view.dispatch({ selection: EditorSelection.range(0, 7) });
		expect(fake.log.local).toEqual([]);
		expect(fake.log.selections).toEqual([[{ anchor: 3, head: 3 }], [{ anchor: 0, head: 7 }]]);
		expect(view.state.doc.toString()).toBe(fake.text());
	});

	test("the view's own edits reach the session with their kind, then the selection", () => {
		const { fake, view } = mount("ab");
		view.dispatch({
			changes: { from: 1, insert: "X" },
			selection: EditorSelection.cursor(2),
			userEvent: "input.type",
		});
		expect(fake.log.local).toEqual([{ changes: [{ from: 1, to: 1, insert: "X" }], kind: "type" }]);
		expect(fake.log.selections.at(-1)).toEqual([{ anchor: 2, head: 2 }]);
		expect(fake.text()).toBe("aXb");
	});

	test("subscribed changes land in the view without echoing back, and disk ones report their writer's text", () => {
		const { fake, view, landed } = mount("one\ntwo\n");
		fake.emit({ changes: [{ from: 4, to: 7, insert: "TWO" }], disk: { hash: "h2" } });
		expect(view.state.doc.toString()).toBe("one\nTWO\n");
		expect(fake.log.local).toEqual([]);
		expect(fake.log.selections).toEqual([]);
		expect(landed).toEqual([
			{ hash: "h2", before: "one\ntwo\n", changes: [{ from: 4, to: 7, insert: "TWO" }] },
		]);
		fake.emit({ changes: [{ from: 0, to: 3, insert: "" }], selection: [{ anchor: 0, head: 0 }] });
		expect(view.state.doc.toString()).toBe("\nTWO\n");
		expect(view.state.selection.main.head).toBe(0);
		expect(landed).toHaveLength(1);
	});

	test("conflicts are reported when the session's list changes, and cleared on dispose", () => {
		const { fake, view, binding, reported } = mount("a\nb\n");
		expect(reported).toEqual([[]]);
		const conflict = { id: 1, from: 0, to: 2, theirs: "A\n" };
		fake.setConflicts([conflict]);
		fake.emit({ changes: [], disk: { hash: "h" } });
		expect(reported.at(-1)).toEqual([conflict]);
		view.dispatch({ selection: EditorSelection.cursor(1) });
		expect(reported).toHaveLength(2);
		binding.dispose();
		expect(reported.at(-1)).toEqual([]);
		expect(fake.listeners.size).toBe(0);
	});

	test("a composition tells the session, and its first step starts a new undo group", () => {
		const { fake, view, binding } = mount("");
		binding.compositionStart();
		view.dispatch({ changes: { from: 0, insert: "k" }, userEvent: "input.type.compose" });
		view.dispatch({ changes: { from: 0, to: 1, insert: "か" }, userEvent: "input.type.compose" });
		binding.compositionEnd();
		binding.compositionEnd();
		expect(fake.log.local.map((entry) => entry.kind)).toEqual(["composeStart", "compose"]);
		expect(fake.log.composing).toEqual([true, false]);
	});

	test("undo and redo go to the session", () => {
		const { fake, binding } = mount("x");
		binding.undo();
		binding.redo();
		binding.redo();
		expect([fake.log.undo, fake.log.redo]).toEqual([1, 2]);
	});
});
