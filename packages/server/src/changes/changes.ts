import { randomBytes } from "node:crypto";
import {
	linkSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
	ChangeReceipt,
	GitDiffScope,
	LineSpan,
	RevertTarget,
	Workspace,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import {
	type CurrentFile,
	classifyBytes,
	createFile,
	decodeText,
	hashBytes,
	replaceFile,
	resolveWorktreeFile,
} from "../fs";
import { readBlobBytesAtAsync, readPathModeAtAsync, resolveDiffRange } from "../git";
import { loadWorkspaces } from "../persistence";
import { trashFile } from "../trash";
import { revertedText, spanFits, splitLines } from "./textSplice";

export interface RevertChangeParams {
	workspaceId: string;
	path: string;
	scope: GitDiffScope;
	target: RevertTarget;
	expect: { originalHash: string | null; modifiedHash: string | null };
}

export type FileMutationQueue = <T>(abs: string, run: () => Promise<T>) => Promise<T>;

export interface FileMutation {
	queue: FileMutationQueue;
	written?: (write: {
		abs: string;
		before: Uint8Array | null;
		after: Uint8Array | null;
		hash?: string;
	}) => void;
}

export interface UndoChangeParams {
	workspaceId: string;
	receiptId: string;
	expect: { modifiedHash: string | null };
}

interface FileState {
	bytes: Uint8Array | null;
	mode: number | null;
}

const RECEIPT_RING = 20;
const RECEIPT_RING_BYTES = 64 * 1024 * 1024;
const BYTES = new TextEncoder();
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GIT_MODE_TYPE = 0o170000;
const GIT_MODE_FILE = 0o100000;
const GIT_MODE_SYMLINK = 0o120000;

function base32(value: bigint, length: number): string {
	let encoded = "";
	for (let index = 0; index < length; index++) {
		encoded = (ULID_ALPHABET[Number(value & 31n)] ?? "0") + encoded;
		value >>= 5n;
	}
	return encoded;
}

function receiptId(): string {
	let random = 0n;
	for (const byte of randomBytes(10)) random = (random << 8n) | BigInt(byte);
	return `${base32(BigInt(Date.now()), 10)}${base32(random, 16)}`;
}

interface ReceiptRecord {
	receipt: ChangeReceipt;
	before: FileState;
}

const rings = new Map<string, ReceiptRecord[]>();

export function retainReceipts<T extends { before: { bytes: Uint8Array | null } }>(
	ring: readonly T[],
	limits: { count: number; bytes: number } = { count: RECEIPT_RING, bytes: RECEIPT_RING_BYTES },
): T[] {
	const retained: T[] = [];
	let bytes = 0;
	for (let index = ring.length - 1; index >= 0; index--) {
		const held = ring[index];
		if (held === undefined) continue;
		const size = held.before.bytes?.byteLength ?? 0;
		if (retained.length > 0 && (retained.length >= limits.count || bytes + size > limits.bytes))
			break;
		retained.unshift(held);
		bytes += size;
	}
	return retained;
}

export function forgetWorkspaceChanges(workspaceId: string): void {
	rings.delete(workspaceId);
}

function workspace(workspaceId: string): Workspace {
	const ws = loadWorkspaces().find((candidate) => candidate.id === workspaceId);
	if (!ws) throw new Error(`Unknown workspace: ${workspaceId}`);
	return ws;
}

function unsupported(path: string, reason: string): never {
	throw new CodedError("UNSUPPORTED_CHANGE", `${path} ${reason}`);
}

function worktreeFile(abs: string, path: string): CurrentFile | null {
	let stat: Stats;
	try {
		stat = lstatSync(abs);
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
		if (code === "ENOENT") return null;
		throw error;
	}
	if (stat.isSymbolicLink())
		unsupported(path, "is a symbolic link, which change mutations do not support.");
	return { stat, bytes: readFileSync(abs) };
}

function stateOf(disk: CurrentFile | null): FileState {
	return disk === null
		? { bytes: null, mode: null }
		: { bytes: disk.bytes, mode: disk.stat.mode & 0o777 };
}

function hashOf(state: FileState): string | null {
	return state.bytes === null ? null : hashBytes(state.bytes);
}

function identity(state: FileState): ChangeReceipt["before"] {
	return state.bytes === null
		? { hash: null, byteLength: null, mode: null }
		: { hash: hashBytes(state.bytes), byteLength: state.bytes.byteLength, mode: state.mode };
}

function writeState(abs: string, state: FileState, disk: CurrentFile | null): void {
	if (state.bytes === null || state.mode === null)
		throw new Error("Cannot write an absent file state");
	if (disk !== null) {
		replaceFile(abs, state.bytes, state.mode, disk);
		return;
	}
	mkdirSync(dirname(abs), { recursive: true });
	createFile(abs, state.bytes, state.mode);
}

function claimForTrash(abs: string): string {
	const claimed = join(dirname(abs), `.thinkrail-revert-${receiptId()}`);
	renameSync(abs, claimed);
	return claimed;
}

function recoveryError(error: unknown, recovery: string): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`${message} The claimed file was preserved at ${recovery}.`, { cause: error });
}

async function trashClaim(claimed: string, abs: string): Promise<void> {
	try {
		await trashFile(claimed);
	} catch (error) {
		try {
			linkSync(claimed, abs);
		} catch {
			const recovery = join(dirname(abs), `.thinkrail-recovery-${receiptId()}`);
			renameSync(claimed, recovery);
			throw recoveryError(error, recovery);
		}
		rmSync(claimed, { force: true });
		throw error;
	}
}

function record(change: {
	kind: ChangeReceipt["kind"];
	workspaceId: string;
	path: string;
	before: FileState;
	after: FileState;
	trashed?: string;
}): ChangeReceipt {
	const receipt: ChangeReceipt = {
		id: receiptId(),
		workspaceId: change.workspaceId,
		path: change.path,
		kind: change.kind,
		at: Date.now(),
		before: identity(change.before),
		after: identity(change.after),
		...(change.trashed === undefined ? {} : { trashed: change.trashed }),
	};
	if (!loadWorkspaces().some((candidate) => candidate.id === change.workspaceId)) return receipt;
	const ring = rings.get(change.workspaceId) ?? [];
	rings.set(change.workspaceId, retainReceipts([...ring, { receipt, before: change.before }]));
	return receipt;
}

function permissionsForGitMode(path: string, mode: number | null): number | null {
	if (mode === null) return null;
	if ((mode & GIT_MODE_TYPE) === GIT_MODE_SYMLINK) {
		unsupported(path, "is a symbolic link in Git, which change mutations do not support.");
	}
	if ((mode & GIT_MODE_TYPE) !== GIT_MODE_FILE) {
		unsupported(path, "is not a regular Git file, which change mutations do not support.");
	}
	return mode & 0o111 ? 0o755 : 0o644;
}

async function originalSide(params: RevertChangeParams): Promise<FileState> {
	const ws = workspace(params.workspaceId);
	const range = await resolveDiffRange(ws, params.scope);
	if (range.modifiedRef !== null) {
		throw new CodedError(
			"SCOPE_IMMUTABLE",
			"This diff's modified side is a commit, not the worktree — there is nothing to revert.",
		);
	}
	if (range.originalRef !== null && range.resolvedOriginalOid === null) {
		throw new CodedError(
			"STALE_VIEW",
			"The original side of this diff no longer resolves — re-read it before reverting.",
		);
	}
	if (!range.resolvedOriginalOid) return { bytes: null, mode: null };
	const [bytes, gitMode] = await Promise.all([
		readBlobBytesAtAsync(ws.worktreePath, range.resolvedOriginalOid, params.path),
		readPathModeAtAsync(ws.worktreePath, range.resolvedOriginalOid, params.path),
	]);
	if ((bytes === null) !== (gitMode === null)) {
		throw new Error(`Could not read a consistent original side for ${params.path}`);
	}
	return { bytes, mode: permissionsForGitMode(params.path, gitMode) };
}

function assertSameView(
	params: RevertChangeParams,
	original: FileState,
	modified: FileState,
): void {
	const stale =
		hashOf(original) !== params.expect.originalHash
			? "original"
			: hashOf(modified) !== params.expect.modifiedHash
				? "modified"
				: null;
	if (stale !== null) {
		throw new CodedError(
			"STALE_VIEW",
			`The ${stale} side of ${params.path} changed since this diff was rendered — re-read it before reverting.`,
		);
	}
}

function assertNotModeOnly(path: string, original: FileState, modified: FileState): void {
	if (
		original.bytes !== null &&
		modified.bytes !== null &&
		hashOf(original) === hashOf(modified) &&
		original.mode !== modified.mode
	) {
		unsupported(path, "has only a mode change, which change mutations do not support.");
	}
}

function revertedRange(
	path: string,
	original: Uint8Array | null,
	modified: Uint8Array | null,
	target: { original: LineSpan; modified: LineSpan },
): Uint8Array {
	if (modified === null) {
		throw new CodedError(
			"RANGE_INVALID",
			`${path} is absent from the worktree — revert the whole file instead of a range.`,
		);
	}
	if (!classifyBytes(modified).text || (original !== null && !classifyBytes(original).text)) {
		throw new CodedError(
			"RANGE_INVALID",
			`${path} is not text — only a whole-file revert applies.`,
		);
	}
	const originalLines = original === null ? [] : splitLines(decodeText(original));
	const modifiedLines = splitLines(decodeText(modified));
	if (!spanFits(target.original, originalLines.length)) {
		throw new CodedError(
			"RANGE_INVALID",
			`Lines ${target.original.start}+${target.original.count} lie outside the original side of ${path} (${originalLines.length} line(s)).`,
		);
	}
	if (!spanFits(target.modified, modifiedLines.length)) {
		throw new CodedError(
			"RANGE_INVALID",
			`Lines ${target.modified.start}+${target.modified.count} lie outside the worktree side of ${path} (${modifiedLines.length} line(s)).`,
		);
	}
	return BYTES.encode(revertedText(originalLines, modifiedLines, target));
}

interface Applied {
	before: FileState;
	after: FileState;
	claimed?: string;
}

const ABSENT: FileState = { bytes: null, mode: null };

function applyRevert(params: RevertChangeParams, abs: string, original: FileState): Applied {
	const disk = worktreeFile(abs, params.path);
	const modified = stateOf(disk);
	assertSameView(params, original, modified);
	assertNotModeOnly(params.path, original, modified);

	if (params.target.kind === "range") {
		const bytes = revertedRange(params.path, original.bytes, modified.bytes, params.target);
		const next = { bytes, mode: modified.mode };
		writeState(abs, next, disk);
		return { before: modified, after: next };
	}
	if (params.target.kind !== "file") {
		throw new CodedError("RANGE_INVALID", `Unknown revert target for ${params.path}.`);
	}
	if (original.bytes === null) {
		if (modified.bytes === null) {
			throw new CodedError(
				"RANGE_INVALID",
				`There is no change to revert for ${params.path} in this scope.`,
			);
		}
		return { before: modified, after: ABSENT, claimed: claimForTrash(abs) };
	}
	writeState(abs, original, disk);
	return { before: modified, after: original };
}

function applyUndo(params: UndoChangeParams, abs: string, held: ReceiptRecord): Applied {
	const disk = worktreeFile(abs, held.receipt.path);
	const current = stateOf(disk);
	const modeMoved =
		held.receipt.after.mode !== null &&
		current.mode !== null &&
		current.mode !== held.receipt.after.mode;
	if (hashOf(current) !== params.expect.modifiedHash || modeMoved) {
		throw new CodedError(
			"STALE_VIEW",
			`${held.receipt.path} changed since the change was applied — nothing was undone.`,
		);
	}
	if (held.before.bytes !== null) {
		writeState(abs, held.before, disk);
		return { before: current, after: held.before };
	}
	if (current.bytes === null) return { before: current, after: held.before };
	return { before: current, after: held.before, claimed: claimForTrash(abs) };
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
	if (a === null || b === null) return a === b;
	return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b);
}

function reported(mutation: FileMutation, abs: string, applied: Applied): Applied {
	const { before, after } = applied;
	if (!sameBytes(before.bytes, after.bytes)) {
		mutation.written?.({ abs, before: before.bytes, after: after.bytes });
	}
	return applied;
}

export async function revertChange(
	params: RevertChangeParams,
	mutation: FileMutation,
): Promise<ChangeReceipt> {
	const original = await originalSide(params);
	const abs = resolveWorktreeFile(params.workspaceId, params.path, { followLeaf: false });
	const applied = await mutation.queue(abs, async () =>
		reported(mutation, abs, applyRevert(params, abs, original)),
	);
	if (applied.claimed !== undefined) await trashClaim(applied.claimed, abs);
	return record({
		kind: "revert",
		workspaceId: params.workspaceId,
		path: params.path,
		before: applied.before,
		after: applied.after,
		...(applied.claimed === undefined ? {} : { trashed: applied.claimed }),
	});
}

export async function undoChange(
	params: UndoChangeParams,
	mutation: FileMutation,
): Promise<ChangeReceipt> {
	const ring = rings.get(params.workspaceId) ?? [];
	const index = ring.findIndex((held) => held.receipt.id === params.receiptId);
	const held = index === -1 ? undefined : ring[index];
	if (held === undefined) {
		throw new CodedError(
			"RECEIPT_UNKNOWN",
			`This change can no longer be undone (receipt ${params.receiptId} is not held by the host).`,
		);
	}
	const abs = resolveWorktreeFile(params.workspaceId, held.receipt.path, { followLeaf: false });
	const applied = await mutation.queue(abs, async () =>
		reported(mutation, abs, applyUndo(params, abs, held)),
	);
	if (applied.claimed !== undefined) await trashClaim(applied.claimed, abs);
	ring.splice(index, 1);
	return record({
		kind: "undo",
		workspaceId: params.workspaceId,
		path: held.receipt.path,
		before: applied.before,
		after: applied.after,
		...(applied.claimed === undefined ? {} : { trashed: applied.claimed }),
	});
}
