import { statSync } from "node:fs";
import { sep } from "node:path";
import type { FileAuthor, FileLastWrite } from "@thinkrail/contracts";
import { hashBytes } from "../fs";
import { editorText, type FileSnapshot, fileKey, firstChangedLine } from "./snapshot";

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
	line?: number;
}

interface BashWindow {
	sessionId: string;
	toolCallId: string;
	root: string;
	startSeq: number;
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
	hash: string;
	seq: number;
	contested: boolean;
}

interface Claim {
	sessionId: string;
	toolCallId: string;
	key: string;
	seq: number;
	mutates: boolean;
	hash: string | null;
}

interface Settled {
	seq: number;
	hash: string | null;
	othersOpen: boolean;
	contested: boolean;
}

const WRITES_PER_PATH = 32;
const MAX_PATHS = 4096;
const BASELINES_PER_SESSION = 1024;
const MAX_SESSIONS = 256;
const RECENT_WRITES = 512;
const MAX_WINDOWS = 256;
const MAX_CLAIMS = 1024;
const TEXT_CACHE_CHARS = 32 * 1024 * 1024;
const TEXT_MAX_CHARS = 512 * 1024;
const UNREAD_RECENT_MS = 10 * 60 * 1000;
const WINDOW_SLACK_MS = 1000;
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

function changedLine(before: string | null | undefined, after: string | null) {
	if (before === undefined || before === null || after === null) return undefined;
	return firstChangedLine(before, after);
}

const textId = (key: string, hash: string) => `${key}\n${hash}`;
const callId = (sessionId: string, toolCallId: string) => `${sessionId}\n${toolCallId}`;

export function createProvenance(options: { now?: () => number } = {}) {
	const now = options.now ?? Date.now;
	const writes = new Map<string, WriteEntry[]>();
	const recent: WriteEntry[] = [];
	const reads = new Map<string, Map<string, Baseline>>();
	const texts = new Map<string, string>();
	const windows: BashWindow[] = [];
	const claims = new Map<string, Claim>();
	let textChars = 0;
	let seq = 0;

	function cacheText(key: string, hash: string, text: string | null): void {
		const id = textId(key, hash);
		const cached = texts.get(id);
		if (cached !== undefined) {
			touch(texts, id, cached, Number.POSITIVE_INFINITY);
			return;
		}
		if (text === null || text.length > TEXT_MAX_CHARS) return;
		texts.set(id, text);
		textChars += text.length;
		for (const [oldest, value] of texts) {
			if (textChars <= TEXT_CACHE_CHARS) break;
			texts.delete(oldest);
			textChars -= value.length;
		}
	}

	function setBaseline(sessionId: string, key: string, baseline: Baseline): void {
		const session = reads.get(sessionId) ?? new Map<string, Baseline>();
		touch(session, key, baseline, BASELINES_PER_SESSION);
		touch(reads, sessionId, session, MAX_SESSIONS);
	}

	function baselineAfter(settled: Settled | undefined, hash: string): Baseline {
		if (settled?.contested) return { hash, seq: settled.seq, contested: true };
		return { hash, seq: ++seq, contested: false };
	}

	function windowAt(key: string, mtimeMs: number): BashWindow | undefined {
		const at = now();
		for (let index = windows.length - 1; index >= 0; index--) {
			const window = windows[index];
			if (!window || !within(key, window.root)) continue;
			const end = (window.end ?? at) + WINDOW_GRACE_MS;
			if (mtimeMs >= window.start - WINDOW_SLACK_MS && mtimeMs <= end) return window;
		}
		return undefined;
	}

	function openClaim(input: {
		sessionId: string;
		toolCallId: string;
		path: string;
		mutates: boolean;
		bytes: Uint8Array | null;
	}): void {
		touch(
			claims,
			callId(input.sessionId, input.toolCallId),
			{
				sessionId: input.sessionId,
				toolCallId: input.toolCallId,
				key: fileKey(input.path),
				seq,
				mutates: input.mutates,
				hash: input.bytes === null ? null : hashBytes(input.bytes),
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
		const othersWrote = (writes.get(key) ?? []).some(
			(entry) => entry.seq > claim.seq && !isSelf(entry, sessionId),
		);
		return {
			seq: claim.seq,
			hash: claim.hash,
			othersOpen,
			contested: othersOpen || othersWrote,
		} satisfies Settled;
	}

	function appendWrite(entry: Omit<WriteEntry, "seq">): void {
		const full = { ...entry, seq: ++seq };
		const ring = [...(writes.get(entry.key) ?? []), full].slice(-WRITES_PER_PATH);
		touch(writes, entry.key, ring, MAX_PATHS);
		recent.push(full);
		if (recent.length > RECENT_WRITES) recent.splice(0, recent.length - RECENT_WRITES);
	}

	function previousText(key: string, author: WriteAuthor): string | undefined {
		const latest = writes.get(key)?.at(-1)?.hash;
		const hash =
			latest ?? (author.kind === "agent" ? reads.get(author.sessionId)?.get(key)?.hash : undefined);
		return hash ? texts.get(textId(key, hash)) : undefined;
	}

	function recordWrite(input: {
		path: string;
		author: WriteAuthor;
		before: Uint8Array | null;
		after: Uint8Array | null;
		line?: number;
		toolCallId?: string;
		changedOnly?: boolean;
	}): void {
		const key = fileKey(input.path);
		const hash = input.after === null ? null : hashBytes(input.after);
		const agent = input.author.kind === "agent" ? input.author : undefined;
		const settled = agent ? settle(agent.sessionId, input.toolCallId, key) : undefined;
		if (input.changedOnly && (!settled || settled.hash === hash)) return;
		const latest = writes.get(key)?.at(-1);
		const adopt = !settled?.othersOpen && !(settled?.contested && latest?.hash === hash);
		const afterText = input.after === null ? null : editorText(input.after);
		if (adopt) {
			const line =
				input.line ??
				changedLine(
					input.before === null ? previousText(key, input.author) : editorText(input.before),
					afterText,
				);
			appendWrite({
				at: now(),
				key,
				path: input.path,
				hash,
				author: input.author,
				...(line === undefined ? {} : { line }),
			});
		}
		if (!agent || hash === null) return;
		setBaseline(agent.sessionId, key, baselineAfter(settled, hash));
		if (!settled?.contested) cacheText(key, hash, afterText);
	}

	function recordRead(input: {
		sessionId: string;
		path: string;
		bytes: Uint8Array;
		toolCallId?: string;
	}): void {
		const key = fileKey(input.path);
		const hash = hashBytes(input.bytes);
		const settled = settle(input.sessionId, input.toolCallId, key);
		setBaseline(input.sessionId, key, baselineAfter(settled, hash));
		if (!settled?.contested) cacheText(key, hash, editorText(input.bytes));
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
		const currentHash = input.current ? hashBytes(input.current.bytes) : null;
		const since = entries.filter((entry) => entry.seq > baseline.seq);
		const writers = since.filter((entry) => !isSelf(entry, input.sessionId));
		if (currentHash === baseline.hash && (!baseline.contested || writers.length === 0)) return null;
		const untracked = currentHash !== baseline.hash && since.at(-1)?.hash !== currentHash;
		if (writers.length === 0 && !untracked) return null;
		const window = untracked && input.current ? windowAt(key, input.current.mtimeMs) : undefined;
		const baselineText = texts.get(textId(key, baseline.hash));
		return {
			read: true,
			writers,
			untracked,
			...(window ? { script: { self: window.sessionId === input.sessionId } } : {}),
			...(baselineText === undefined ? {} : { baselineText }),
		};
	}

	function openBashWindow(input: { sessionId: string; toolCallId: string; cwd: string }): void {
		windows.push({
			sessionId: input.sessionId,
			toolCallId: input.toolCallId,
			root: fileKey(input.cwd),
			startSeq: seq,
			start: now(),
		});
		if (windows.length > MAX_WINDOWS) windows.splice(0, windows.length - MAX_WINDOWS);
	}

	function closeBashWindow(input: { sessionId: string; toolCallId: string }): WriteEntry[] | null {
		const window = windows.find(
			(candidate) =>
				candidate.sessionId === input.sessionId &&
				candidate.toolCallId === input.toolCallId &&
				candidate.end === undefined,
		);
		if (!window) return null;
		window.end = now();
		return recent.filter(
			(entry) =>
				entry.author.kind === "user" &&
				entry.seq > window.startSeq &&
				within(entry.key, window.root),
		);
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
		const hit = entries.findLast((entry) => entry.hash === input.hash);
		if (hit) {
			const author: FileAuthor =
				hit.author.kind === "user"
					? { kind: "user", thisClient: hit.author.clientKey === input.clientKey }
					: hit.author;
			return { author, at: hit.at };
		}
		if (entries.length === 0 && !windows.some((window) => within(key, window.root))) {
			return undefined;
		}
		const mtimeMs = mtimeOf(input.path);
		if (mtimeMs === undefined) return undefined;
		const window = windowAt(key, mtimeMs);
		if (window) {
			return {
				author: { kind: "agent", sessionId: window.sessionId, via: "script", inferred: true },
				at: mtimeMs,
			};
		}
		if (entries.length > 0) return { author: { kind: "external", inferred: true }, at: mtimeMs };
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
