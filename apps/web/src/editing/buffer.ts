import {
	FILE_WRITE_MAX_BYTES,
	type FileContent,
	type FileWriteResult,
	type ResourceMeta,
	toEditorText,
} from "@thinkrail/contracts";
import type { FileBufferError, FileBufferStatus, FileBufferSummary } from "../store";

const LFS_MIME = "application/vnd.git-lfs";

/** A disk state the buffer adopted; `hash: null` means the file is absent. */
interface DiskText {
	text: string;
	hash: string | null;
}

type BufferIssue =
	| { kind: "conflict"; disk: DiskText }
	| { kind: "readonly" }
	| { kind: "error"; error: FileBufferError };

export interface BufferState {
	text: string;
	base: DiskText;
	saving: { text: string } | null;
	issue: BufferIssue | null;
}

interface SaveRequest {
	content: string;
	expect: { hash: string | null };
}

export function isEditableMeta(meta: Pick<ResourceMeta, "text" | "mime">): boolean {
	return meta.text && meta.mime !== LFS_MIME;
}

export function editorDisk(file: FileContent): DiskText | null {
	if (!isEditableMeta(file.meta) || file.meta.hash === null) return null;
	return { text: toEditorText(file.content), hash: file.meta.hash };
}

export function createBuffer(disk: DiskText): BufferState {
	return { text: disk.text, base: disk, saving: null, issue: null };
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

export function adoptDisk(state: BufferState, disk: DiskText): BufferState {
	if (disk.hash === state.base.hash) {
		const outdated = state.issue?.kind === "conflict" && state.issue.disk.hash !== disk.hash;
		return outdated ? { ...state, issue: null } : state;
	}
	if (state.base.hash === null && disk.text === state.base.text) {
		return { ...state, base: disk, issue: null };
	}
	if (!isDirty(state) || disk.text === state.text) {
		return { ...state, text: disk.text, base: disk, issue: null };
	}
	return { ...state, issue: { kind: "conflict", disk } };
}

export function markNotEditable(state: BufferState): BufferState {
	return { ...state, issue: { kind: "error", error: "notEditable" } };
}

export function markMissing(state: BufferState): BufferState {
	if (state.base.hash === null && state.issue === null) return state;
	return { ...state, base: { text: state.base.text, hash: null }, issue: null };
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
				: { ...settled, base: { text: sent, hash: result.meta.hash }, issue: null };
		case "stale": {
			const disk = editorDisk(result.current);
			if (!disk) return markNotEditable(settled);
			if (disk.text === state.text) return { ...settled, base: disk, issue: null };
			return { ...settled, issue: { kind: "conflict", disk } };
		}
		case "missing":
			return markMissing(settled);
		case "readonly":
			return { ...settled, issue: { kind: "readonly" } };
	}
}

export function failSave(state: BufferState, error: FileBufferError): BufferState {
	return { ...state, saving: null, issue: { kind: "error", error } };
}

export function reloadFromDisk(state: BufferState): BufferState {
	if (state.issue?.kind !== "conflict") return state;
	const { disk } = state.issue;
	return { ...state, text: disk.text, base: disk, issue: null };
}

export function keepMine(state: BufferState): BufferState {
	if (state.issue?.kind !== "conflict") return state;
	return { ...state, base: state.issue.disk, issue: null };
}

export function restoreDraft(
	state: BufferState,
	draft: { text: string; baseHash: string | null },
): BufferState {
	if (isDirty(state) || state.saving || draft.text === state.text) return state;
	if (draft.baseHash === state.base.hash) return { ...state, text: draft.text };
	return { ...state, text: draft.text, issue: { kind: "conflict", disk: state.base } };
}
