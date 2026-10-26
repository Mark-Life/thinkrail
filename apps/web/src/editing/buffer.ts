import type { EditorState } from "@codemirror/state";
import {
	FILE_WRITE_MAX_BYTES,
	type FileContent,
	type FileWriteResult,
	toEditorText,
} from "@thinkrail/contracts";
import type { ConflictChoice, LocalEditKind, TextChange } from "@thinkrail/resource-renderers";
import type { FileBufferError, FileBufferStatus, FileBufferSummary } from "../store";
import type { Draft } from "./drafts";
import {
	clearTypedOn,
	conflictsOf,
	createDoc,
	docText,
	localChange,
	reloadText,
	remoteText,
	resolveDocConflict,
	type TypedOn,
	typedOnOf,
} from "./history";
import { isEditableMeta } from "./keys";
import { type MergeConflict, merge3 } from "./merge3";

interface DiskText {
	text: string;
	hash: string | null;
}

type BufferIssue =
	| { kind: "conflict"; disk: DiskText; typedOn: string | null }
	| { kind: "readonly" }
	| { kind: "error"; error: FileBufferError };

export interface BufferState {
	doc: EditorState;
	base: DiskText;
	saving: { text: string; expect: string | null } | null;
	unconfirmed: string | null;
	issue: BufferIssue | null;
	merges: number;
}

interface SaveRequest {
	content: string;
	expect: { hash: string | null };
}

export function editorDisk(file: FileContent): DiskText | null {
	if (!isEditableMeta(file.meta) || file.meta.hash === null) return null;
	return { text: toEditorText(file.content), hash: file.meta.hash };
}

export function createBuffer(disk: DiskText): BufferState {
	return {
		doc: createDoc(disk.text),
		base: disk,
		saving: null,
		unconfirmed: null,
		issue: null,
		merges: 0,
	};
}

export function bufferText(state: Pick<BufferState, "doc">): string {
	return docText(state.doc);
}

export function withDoc(state: BufferState, doc: EditorState): BufferState {
	if (doc === state.doc) return state;
	return { ...state, doc };
}

function withDiskText(state: BufferState, text: string): BufferState {
	return withDoc(state, remoteText(state.doc, { text, clear: true }));
}

function openConflicts(state: BufferState): number {
	return conflictsOf(state.doc).length;
}

export function isDirty(state: BufferState): boolean {
	return bufferText(state) !== state.base.text;
}

export function canAutosave(state: BufferState): boolean {
	return (
		state.base.hash !== null &&
		state.issue?.kind !== "conflict" &&
		state.issue?.kind !== "readonly" &&
		openConflicts(state) === 0
	);
}

export function bufferStatus(state: BufferState): FileBufferStatus {
	if (state.issue?.kind === "conflict") return "stale";
	if (state.issue?.kind === "readonly") return "readonly";
	if (state.issue?.kind === "error") return "error";
	if (state.base.hash === null) return "deleted";
	if (openConflicts(state) > 0) return "conflict";
	if (state.saving) return "saving";
	return isDirty(state) ? "dirty" : "clean";
}

export function bufferSummary(state: BufferState): FileBufferSummary {
	const status = bufferStatus(state);
	const conflicts = openConflicts(state);
	return {
		status,
		dirty: isDirty(state),
		...(status === "error" && state.issue?.kind === "error" ? { error: state.issue.error } : {}),
		...(conflicts > 0 ? { conflicts } : {}),
		...(state.merges > 0 ? { merges: state.merges } : {}),
	};
}

export function localEdit(
	state: BufferState,
	changes: readonly TextChange[],
	kind: LocalEditKind,
): BufferState {
	return withDoc(state, localChange(state.doc, changes, kind));
}

export function resolveConflict(
	state: BufferState,
	id: number,
	choice: ConflictChoice,
): BufferState {
	return withDoc(state, resolveDocConflict(state.doc, id, choice));
}

function typedOn(state: BufferState): TypedOn {
	return typedOnOf(state.doc) ?? state.base;
}

export function draftBaseHash(state: BufferState): string | null {
	return state.issue?.kind === "conflict" ? state.issue.typedOn : typedOn(state).hash;
}

function conflict(state: BufferState, disk: DiskText): BufferIssue {
	return { kind: "conflict", disk, typedOn: draftBaseHash(state) };
}

function settledOn(state: BufferState, base: DiskText): BufferState {
	return { ...withDoc(state, clearTypedOn(state.doc)), base, unconfirmed: null, issue: null };
}

function savedOn(state: BufferState, base: DiskText, sentOn: string | null): BufferState {
	if (typedOn(state).hash === sentOn) return settledOn(state, base);
	return { ...state, base, unconfirmed: null, issue: null };
}

function clearedByRead(issue: BufferIssue | null, disk: DiskText): boolean {
	if (issue?.kind === "conflict") return issue.disk.hash !== disk.hash;
	return issue?.kind === "error" && (issue.error === "notEditable" || issue.error === "offline");
}

function mergeDisk(state: BufferState, disk: DiskText): BufferState {
	const { text: base } = typedOn(state);
	const result =
		base === null ? null : merge3({ base, mine: bufferText(state), theirs: disk.text });
	if (result === null || result.kind === "tooLarge")
		return { ...state, unconfirmed: null, issue: conflict(state, disk) };
	const merged = remoteText(state.doc, {
		text: result.text,
		changes: result.changes,
		add: result.conflicts,
		touched: result.touched,
	});
	const silent = result.conflicts.length === 0 && !result.changes.empty;
	const merges = silent ? state.merges + 1 : state.merges;
	return settledOn({ ...withDoc(state, merged), merges }, disk);
}

export function adoptDisk(state: BufferState, disk: DiskText): BufferState {
	if (disk.hash === state.base.hash) {
		return clearedByRead(state.issue, disk) ? { ...state, issue: null } : state;
	}
	if (state.unconfirmed !== null && disk.text === state.unconfirmed) return settledOn(state, disk);
	if (state.base.hash === null && disk.text === state.base.text) return settledOn(state, disk);
	if (disk.text === bufferText(state)) return settledOn(withDiskText(state, disk.text), disk);
	if (!isDirty(state)) {
		return settledOn(withDoc(state, remoteText(state.doc, { text: disk.text })), disk);
	}
	if (state.issue?.kind === "conflict") return { ...state, issue: conflict(state, disk) };
	return mergeDisk(state, disk);
}

export function markError(state: BufferState, error: FileBufferError): BufferState {
	return { ...state, issue: { kind: "error", error } };
}

export function markMissing(state: BufferState): BufferState {
	if (state.base.hash === null && state.issue === null) return state;
	return settledOn(withDiskText(state, bufferText(state)), { text: state.base.text, hash: null });
}

function utf8Length(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

export function beginSave(state: BufferState): { state: BufferState; request: SaveRequest | null } {
	if (state.saving || state.issue?.kind === "conflict" || openConflicts(state) > 0) {
		return { state, request: null };
	}
	if (!isDirty(state) && state.base.hash !== null) {
		return { state: state.issue ? { ...state, issue: null } : state, request: null };
	}
	if (utf8Length(bufferText(state)) > FILE_WRITE_MAX_BYTES) {
		return { state: { ...state, issue: { kind: "error", error: "tooLarge" } }, request: null };
	}
	const text = bufferText(state);
	const expect = typedOn(state).hash;
	return {
		state: { ...state, saving: { text, expect }, issue: null },
		request: { content: text, expect: { hash: expect } },
	};
}

export function finishSave(state: BufferState, result: FileWriteResult): BufferState {
	const sent = state.saving?.text ?? bufferText(state);
	const sentOn = state.saving ? state.saving.expect : typedOn(state).hash;
	const settled = { ...state, saving: null };
	switch (result.status) {
		case "written":
			return result.meta.hash === null
				? settled
				: savedOn(settled, { text: sent, hash: result.meta.hash }, sentOn);
		case "stale": {
			const disk = editorDisk(result.current);
			if (!disk) return markError(settled, "notEditable");
			if (disk.text === bufferText(state)) return settledOn(settled, disk);
			if (disk.text === state.unconfirmed) return savedOn(settled, disk, sentOn);
			return mergeDisk({ ...settled, unconfirmed: null }, disk);
		}
		case "missing":
			return markMissing(settled);
		case "readonly":
			return { ...settled, issue: { kind: "readonly" } };
	}
}

export function failSave(state: BufferState, error: FileBufferError): BufferState {
	const unconfirmed = state.saving?.text ?? state.unconfirmed;
	return markError({ ...state, saving: null, unconfirmed }, error);
}

export function reloadFromDisk(state: BufferState): BufferState {
	if (state.issue?.kind !== "conflict") return state;
	const { disk, typedOn: typedOnHash } = state.issue;
	const previous =
		typedOnOf(state.doc) ??
		(typedOnHash === state.base.hash ? state.base : { text: null, hash: typedOnHash });
	return settledOn(withDoc(state, reloadText(state.doc, disk.text, previous)), disk);
}

export function keepMine(state: BufferState): BufferState {
	if (state.issue?.kind !== "conflict") return state;
	return settledOn(withDiskText(state, bufferText(state)), state.issue.disk);
}

export function draftConflicts(state: BufferState): MergeConflict[] {
	return conflictsOf(state.doc).map(({ id: _id, ...conflict }) => conflict);
}

export function restoreDraft(
	state: BufferState,
	draft: Pick<Draft, "text" | "baseHash" | "conflicts">,
): BufferState {
	if (isDirty(state) || state.saving || draft.text === bufferText(state)) return state;
	if (draft.baseHash === state.base.hash) {
		const add = (draft.conflicts ?? []).filter(
			(conflict) => conflict.from <= conflict.to && conflict.to <= draft.text.length,
		);
		return withDoc(state, remoteText(state.doc, { text: draft.text, add }));
	}
	const restored = withDoc(state, remoteText(state.doc, { text: draft.text }));
	return { ...restored, issue: { kind: "conflict", disk: state.base, typedOn: draft.baseHash } };
}
