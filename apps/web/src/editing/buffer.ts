import {
	FILE_WRITE_MAX_BYTES,
	type FileContent,
	type FileWriteResult,
	LFS_POINTER_MIME,
	type ResourceMeta,
	toEditorText,
} from "@thinkrail/contracts";
import type { FileBufferError, FileBufferStatus, FileBufferSummary } from "../store";

interface DiskText {
	text: string;
	hash: string | null;
}

type BufferIssue =
	| { kind: "conflict"; disk: DiskText; typedOn: string | null }
	| { kind: "readonly" }
	| { kind: "error"; error: FileBufferError };

export interface BufferState {
	text: string;
	base: DiskText;
	saving: { text: string } | null;
	unconfirmed: string | null;
	issue: BufferIssue | null;
}

interface SaveRequest {
	content: string;
	expect: { hash: string | null };
}

export function isEditableMeta(meta: Pick<ResourceMeta, "text" | "mime">): boolean {
	return meta.text && meta.mime !== LFS_POINTER_MIME;
}

export function editorDisk(file: FileContent): DiskText | null {
	if (!isEditableMeta(file.meta) || file.meta.hash === null) return null;
	return { text: toEditorText(file.content), hash: file.meta.hash };
}

export function createBuffer(disk: DiskText): BufferState {
	return { text: disk.text, base: disk, saving: null, unconfirmed: null, issue: null };
}

export function isDirty(state: BufferState): boolean {
	return state.text !== state.base.text;
}

export function bufferStatus(state: BufferState): FileBufferStatus {
	if (state.issue?.kind === "conflict") return "stale";
	if (state.issue?.kind === "readonly") return "readonly";
	if (state.issue?.kind === "error") return "error";
	if (state.base.hash === null) return "deleted";
	if (state.saving) return "saving";
	return isDirty(state) ? "dirty" : "clean";
}

export function bufferSummary(state: BufferState): FileBufferSummary {
	const status = bufferStatus(state);
	return {
		status,
		dirty: isDirty(state),
		...(status === "error" && state.issue?.kind === "error" ? { error: state.issue.error } : {}),
	};
}

export function localEdit(state: BufferState, text: string): BufferState {
	return text === state.text ? state : { ...state, text };
}

export function draftBaseHash(state: BufferState): string | null {
	return state.issue?.kind === "conflict" ? state.issue.typedOn : state.base.hash;
}

function conflict(state: BufferState, disk: DiskText): BufferIssue {
	return { kind: "conflict", disk, typedOn: draftBaseHash(state) };
}

function settledOn(state: BufferState, base: DiskText): BufferState {
	return { ...state, base, unconfirmed: null, issue: null };
}

function clearedByRead(issue: BufferIssue | null, disk: DiskText): boolean {
	if (issue?.kind === "conflict") return issue.disk.hash !== disk.hash;
	return issue?.kind === "error" && (issue.error === "notEditable" || issue.error === "offline");
}

export function adoptDisk(state: BufferState, disk: DiskText): BufferState {
	if (disk.hash === state.base.hash) {
		return clearedByRead(state.issue, disk) ? { ...state, issue: null } : state;
	}
	if (state.unconfirmed !== null && disk.text === state.unconfirmed) return settledOn(state, disk);
	if (state.base.hash === null && disk.text === state.base.text) return settledOn(state, disk);
	if (!isDirty(state) || disk.text === state.text) {
		return settledOn({ ...state, text: disk.text }, disk);
	}
	return { ...state, issue: conflict(state, disk) };
}

export function markError(state: BufferState, error: FileBufferError): BufferState {
	return { ...state, issue: { kind: "error", error } };
}

export function markMissing(state: BufferState): BufferState {
	if (state.base.hash === null && state.issue === null) return state;
	return settledOn(state, { text: state.base.text, hash: null });
}

function utf8Length(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

export function beginSave(state: BufferState): { state: BufferState; request: SaveRequest | null } {
	if (state.saving || state.issue?.kind === "conflict") return { state, request: null };
	if (!isDirty(state) && state.base.hash !== null) {
		return { state: state.issue ? { ...state, issue: null } : state, request: null };
	}
	if (utf8Length(state.text) > FILE_WRITE_MAX_BYTES) {
		return { state: { ...state, issue: { kind: "error", error: "tooLarge" } }, request: null };
	}
	return {
		state: { ...state, saving: { text: state.text }, issue: null },
		request: { content: state.text, expect: { hash: state.base.hash } },
	};
}

export function finishSave(state: BufferState, result: FileWriteResult): BufferState {
	const sent = state.saving?.text ?? state.text;
	const settled = { ...state, saving: null };
	switch (result.status) {
		case "written":
			return result.meta.hash === null
				? settled
				: settledOn(settled, { text: sent, hash: result.meta.hash });
		case "stale": {
			const disk = editorDisk(result.current);
			if (!disk) return markError(settled, "notEditable");
			if (disk.text === state.text || disk.text === state.unconfirmed) {
				return settledOn(settled, disk);
			}
			return { ...settled, unconfirmed: null, issue: conflict(settled, disk) };
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
	const { disk } = state.issue;
	return settledOn({ ...state, text: disk.text }, disk);
}

export function keepMine(state: BufferState): BufferState {
	if (state.issue?.kind !== "conflict") return state;
	return settledOn(state, state.issue.disk);
}

export function restoreDraft(
	state: BufferState,
	draft: { text: string; baseHash: string | null },
): BufferState {
	if (isDirty(state) || state.saving || draft.text === state.text) return state;
	if (draft.baseHash === state.base.hash) return { ...state, text: draft.text };
	return {
		...state,
		text: draft.text,
		issue: { kind: "conflict", disk: state.base, typedOn: draft.baseHash },
	};
}
