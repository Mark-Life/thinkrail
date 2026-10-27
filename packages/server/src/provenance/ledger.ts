import { statSync } from "node:fs";
import { sep } from "node:path";
import type { FileAuthor, FileLastWrite } from "@thinkrail/contracts";
import { hashBytes } from "../fs";
import { editorText, type FileSnapshot, fileKey } from "./snapshot";

export type WriteAuthor =
	| { kind: "user"; clientKey: string }
	| Extract<FileAuthor, { kind: "agent"; via: "tool" }>;

export interface WriteEntry {
	seq: number;
	at: number;
	key: string;
	path: string;
	hash: string | null;
	author: WriteAuthor;
	provisional?: boolean;
}

interface BashWindow {
	sessionId: string;
	toolCallId: string;
	root: string;
	start: number;
	end?: number;
}

export interface StaleRead {
	read: boolean;
	writers: WriteEntry[];
	untracked: boolean;
	script?: { self: boolean };
	baselineText?: string;
}

interface Baseline {
	hash: string | null;
	seq: number;
	at: number;
	contested: boolean;
	unseen?: true;
}

interface Claim {
	sessionId: string;
	key: string;
	seq: number;
	mutates: boolean;
	hash: string | null;
	kept?: Baseline;
}

interface Settled {
	seq: number;
	hash: string | null;
	othersOpen: boolean;
	contested: boolean;
	kept?: Baseline;
}

const WRITES_PER_PATH = 32;
const MAX_PATHS = 4096;
const BASELINES_PER_SESSION = 1024;
const MAX_SESSIONS = 256;
const MAX_WINDOWS = 256;
const MAX_CLAIMS = 1024;
const TEXT_CACHE_CHARS = 32 * 1024 * 1024;
const TEXT_MAX_CHARS = 512 * 1024;
const TEXT_MAX_BYTES = 4 * TEXT_MAX_CHARS;
const UNREAD_RECENT_MS = 10 * 60 * 1000;
const WINDOW_SLACK_MS = 2000;
const WINDOW_GRACE_MS = 1500;

function touch<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
	map.delete(key);
	map.set(key, value);
	while (map.size > max) {
		const oldest = map.keys().next();
		if (oldest.done) return;
		map.delete(oldest.value);
	}
}

function isSelf(entry: WriteEntry, sessionId: string): boolean {
	return entry.author.kind === "agent" && entry.author.sessionId === sessionId;
}

function within(key: string, root: string): boolean {
	return key === root || key.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function mtimeOf(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}

const textId = (key: string, hash: string) => `${key}\n${hash}`;
const callId = (sessionId: string, toolCallId: string) => `${sessionId}\n${toolCallId}`;

export function createProvenance(options: { now?: () => number } = {}) {
	const now = options.now ?? Date.now;
	const writes = new Map<string, WriteEntry[]>();
	const reads = new Map<string, Map<string, Baseline>>();
	const texts = new Map<string, string>();
	const windows: BashWindow[] = [];
	const claims = new Map<string, Claim>();
	let textChars = 0;
	let seq = 0;

	function cacheText(key: string, hash: string, bytes: Uint8Array): void {
		const id = textId(key, hash);
		const cached = texts.get(id);
		if (cached !== undefined) {
			touch(texts, id, cached, Number.POSITIVE_INFINITY);
			return;
		}
		if (bytes.length > TEXT_MAX_BYTES) return;
		const value = editorText(bytes);
		if (value === null || value.length > TEXT_MAX_CHARS) return;
		texts.set(id, value);
		textChars += value.length;
		for (const [oldest, old] of texts) {
			if (textChars <= TEXT_CACHE_CHARS) break;
			texts.delete(oldest);
			textChars -= old.length;
		}
	}

	function setBaseline(sessionId: string, key: string, baseline: Baseline): void {
		const session = reads.get(sessionId) ?? new Map<string, Baseline>();
		touch(session, key, baseline, BASELINES_PER_SESSION);
		touch(reads, sessionId, session, MAX_SESSIONS);
	}

	function baselineAfter(settled: Settled | undefined, hash: string | null): Baseline {
		if (settled?.kept) return settled.kept;
		if (settled?.contested) return { hash, seq: settled.seq, at: now(), contested: true };
		return { hash, seq: ++seq, at: now(), contested: false };
	}

	function changedSince(input: {
		sessionId: string;
		key: string;
		baseline: Baseline;
		hash: string | null;
	}) {
		const { baseline, hash } = input;
		const since = (writes.get(input.key) ?? []).filter((entry) => entry.seq > baseline.seq);
		const writers = since.filter((entry) => !isSelf(entry, input.sessionId));
		if (hash === baseline.hash && (!baseline.contested || writers.length === 0)) return null;
		const untracked =
			baseline.unseen === true || (hash !== baseline.hash && since.at(-1)?.hash !== hash);
		if (writers.length === 0 && !untracked) return null;
		return { writers, untracked };
	}

	function windowsAt(key: string, mtimeMs: number): BashWindow[] {
		const at = now();
		return windows.filter(
			(window) =>
				within(key, window.root) &&
				mtimeMs >= window.start - WINDOW_SLACK_MS &&
				mtimeMs <= (window.end ?? at) + WINDOW_GRACE_MS,
		);
	}

	function scriptWindows(key: string, since: number, mtimeMs: number | undefined): BashWindow[] {
		if (mtimeMs !== undefined && mtimeMs >= since - WINDOW_SLACK_MS) return windowsAt(key, mtimeMs);
		const at = now();
		return windows.filter((window) => within(key, window.root) && (window.end ?? at) >= since);
	}

	function openClaim(input: {
		sessionId: string;
		toolCallId: string;
		path: string;
		mutates: boolean;
		hash: string | null;
	}): void {
		const key = fileKey(input.path);
		const baseline = input.mutates ? reads.get(input.sessionId)?.get(key) : undefined;
		const unseen = baseline && changedSince({ ...input, key, baseline });
		const kept = unseen && { ...baseline, ...(unseen.untracked ? { unseen: true as const } : {}) };
		touch(
			claims,
			callId(input.sessionId, input.toolCallId),
			{
				sessionId: input.sessionId,
				key,
				seq,
				mutates: input.mutates,
				hash: input.hash,
				...(kept ? { kept } : {}),
			},
			MAX_CLAIMS,
		);
	}

	function settle(sessionId: string, toolCallId: string | undefined, key: string) {
		if (toolCallId === undefined) return undefined;
		const id = callId(sessionId, toolCallId);
		const claim = claims.get(id);
		claims.delete(id);
		if (!claim || claim.key !== key) return undefined;
		const othersOpen = [...claims.values()].some(
			(other) => other.mutates && other.key === key && other.sessionId !== sessionId,
		);
		const writers = (writes.get(key) ?? []).filter(
			(entry) => entry.seq > claim.seq && !isSelf(entry, sessionId),
		);
		return {
			seq: claim.seq,
			hash: claim.hash,
			othersOpen,
			contested: othersOpen || writers.length > 0,
			...(claim.kept ? { kept: claim.kept } : {}),
		} satisfies Settled;
	}

	function appendWrite(entry: Omit<WriteEntry, "seq">): void {
		const ring = [...(writes.get(entry.key) ?? []), { ...entry, seq: ++seq }].slice(
			-WRITES_PER_PATH,
		);
		touch(writes, entry.key, ring, MAX_PATHS);
	}

	function takeOver(key: string, entry: WriteEntry, author: WriteAuthor): void {
		const ring = writes.get(key);
		if (ring?.at(-1) === entry) ring[ring.length - 1] = { ...entry, author, provisional: false };
	}

	function recordWrite(input: {
		path: string;
		author: WriteAuthor;
		after: Uint8Array | null;
		hash?: string;
		toolCallId?: string;
		changedOnly?: boolean;
	}): void {
		const key = fileKey(input.path);
		const after = input.after;
		const hash = after === null ? null : (input.hash ?? hashBytes(after));
		const agent = input.author.kind === "agent" ? input.author : undefined;
		const settled = agent ? settle(agent.sessionId, input.toolCallId, key) : undefined;
		if (input.changedOnly && (!settled || settled.hash === hash)) return;
		const latest = writes.get(key)?.at(-1);
		if (settled?.contested && latest?.hash === hash) {
			if (latest.provisional && latest.seq > settled.seq) takeOver(key, latest, input.author);
		} else {
			appendWrite({
				at: now(),
				key,
				path: input.path,
				hash,
				author: input.author,
				...(settled?.othersOpen ? { provisional: true } : {}),
			});
		}
		if (!agent || after === null || hash === null) return;
		setBaseline(agent.sessionId, key, baselineAfter(settled, hash));
		if (!settled?.contested) cacheText(key, hash, after);
	}

	function recordRead(input: {
		sessionId: string;
		path: string;
		bytes: Uint8Array | null;
		hash?: string;
		toolCallId?: string;
	}): void {
		const key = fileKey(input.path);
		const hash = input.bytes === null ? null : (input.hash ?? hashBytes(input.bytes));
		const settled = settle(input.sessionId, input.toolCallId, key);
		setBaseline(input.sessionId, key, baselineAfter(settled, hash));
		if (input.bytes !== null && hash !== null && !settled?.contested) {
			cacheText(key, hash, input.bytes);
		}
	}

	function staleRead(input: {
		sessionId: string;
		path: string;
		current: FileSnapshot | null;
	}): StaleRead | null {
		const key = fileKey(input.path);
		const entries = writes.get(key) ?? [];
		const baseline = reads.get(input.sessionId)?.get(key);
		if (!baseline) {
			const lastSelf = entries.findLastIndex((entry) => isSelf(entry, input.sessionId));
			const cutoff = now() - UNREAD_RECENT_MS;
			const writers = entries
				.slice(lastSelf + 1)
				.filter((entry) => !isSelf(entry, input.sessionId) && entry.at >= cutoff);
			if (writers.length === 0) return null;
			return { read: false, writers, untracked: false };
		}
		const hash = input.current?.hash ?? null;
		const changed = changedSince({ sessionId: input.sessionId, key, baseline, hash });
		if (!changed) return null;
		const { writers, untracked } = changed;
		const mtimeMs = baseline.unseen ? undefined : input.current?.mtimeMs;
		const covering = untracked ? scriptWindows(key, baseline.at, mtimeMs) : [];
		const baselineText = baseline.hash === null ? undefined : texts.get(textId(key, baseline.hash));
		const self = covering.every((window) => window.sessionId === input.sessionId);
		return {
			read: true,
			writers,
			untracked,
			...(covering.length > 0 ? { script: { self } } : {}),
			...(baselineText === undefined ? {} : { baselineText }),
		};
	}

	function openBashWindow(input: { sessionId: string; toolCallId: string; cwd: string }): void {
		windows.push({
			sessionId: input.sessionId,
			toolCallId: input.toolCallId,
			root: fileKey(input.cwd),
			start: now(),
		});
		while (windows.length > MAX_WINDOWS) {
			const closed = windows.findIndex((window) => window.end !== undefined);
			windows.splice(Math.max(closed, 0), 1);
		}
	}

	function closeBashWindow(input: { sessionId: string; toolCallId: string }): void {
		const window = windows.find(
			(candidate) =>
				candidate.sessionId === input.sessionId &&
				candidate.toolCallId === input.toolCallId &&
				candidate.end === undefined,
		);
		if (window) window.end = now();
	}

	function endTool(input: { sessionId: string; toolCallId: string }): void {
		claims.delete(callId(input.sessionId, input.toolCallId));
		closeBashWindow(input);
	}

	function lastWrite(input: {
		path: string;
		hash: string | null;
		clientKey: string;
	}): FileLastWrite | undefined {
		if (input.hash === null) return undefined;
		const key = fileKey(input.path);
		const entries = writes.get(key) ?? [];
		const newest = entries.at(-1);
		if (newest && newest.hash === input.hash) {
			const author: FileAuthor =
				newest.author.kind === "user"
					? { kind: "user", thisClient: newest.author.clientKey === input.clientKey }
					: newest.author;
			return { author, at: newest.at };
		}
		if (entries.length === 0 && !windows.some((window) => within(key, window.root))) {
			return undefined;
		}
		const mtimeMs = mtimeOf(input.path);
		if (mtimeMs === undefined) return undefined;
		const since = newest?.at ?? Number.NEGATIVE_INFINITY;
		const window = scriptWindows(key, since, mtimeMs).at(-1);
		if (window) {
			return {
				author: { kind: "agent", sessionId: window.sessionId, via: "script" },
				at: mtimeMs,
			};
		}
		if (entries.length > 0) return { author: { kind: "external" }, at: mtimeMs };
		return undefined;
	}

	function forgetSession(sessionId: string): void {
		reads.delete(sessionId);
		for (const [id, claim] of claims) if (claim.sessionId === sessionId) claims.delete(id);
		for (const window of windows) {
			if (window.sessionId === sessionId && window.end === undefined) window.end = now();
		}
	}

	return {
		now,
		recordWrite,
		recordRead,
		openClaim,
		staleRead,
		openBashWindow,
		closeBashWindow,
		endTool,
		lastWrite,
		forgetSession,
	};
}

export type Provenance = ReturnType<typeof createProvenance>;

export const fileProvenance = createProvenance();
