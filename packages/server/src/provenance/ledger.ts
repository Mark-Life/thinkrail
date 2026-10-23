import { statSync } from "node:fs";
import type { FileAuthor, FileLastWrite } from "@thinkrail/contracts";
import { hashBytes } from "../fs";
import {
	editorText,
	type FileSnapshot,
	fileKey,
	firstChangedLine,
	readSnapshot,
	sameBytes,
} from "./snapshot";

export type WriteAuthor =
	| { kind: "user"; clientKey: string }
	| Extract<FileAuthor, { kind: "agent"; via: "tool" }>;

export interface WriteEntry {
	seq: number;
	at: number;
	path: string;
	hash: string;
	author: WriteAuthor;
	line?: number;
}

export interface BashWindow {
	sessionId: string;
	toolCallId: string;
	startSeq: number;
	start: number;
	endSeq?: number;
	end?: number;
}

export interface StaleRead {
	path: string;
	baseline: { hash: string; at: number } | null;
	writers: WriteEntry[];
	untracked: boolean;
	script?: { sessionId: string; self: boolean };
	baselineText?: string;
}

interface Baseline {
	hash: string;
	seq: number;
	at: number;
}

const WRITES_PER_PATH = 32;
const MAX_PATHS = 4096;
const BASELINES_PER_SESSION = 1024;
const MAX_SESSIONS = 256;
const RECENT_WRITES = 512;
const MAX_WINDOWS = 256;
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

function mtimeOf(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}

export function createProvenance(options: { now?: () => number } = {}) {
	const now = options.now ?? Date.now;
	const writes = new Map<string, WriteEntry[]>();
	const recent: WriteEntry[] = [];
	const reads = new Map<string, Map<string, Baseline>>();
	const texts = new Map<string, string>();
	const windows: BashWindow[] = [];
	let textChars = 0;
	let seq = 0;

	function cacheText(key: string, hash: string, bytes: Uint8Array): void {
		const id = `${key}\n${hash}`;
		const cached = texts.get(id);
		if (cached !== undefined) {
			touch(texts, id, cached, Number.POSITIVE_INFINITY);
			return;
		}
		const text = editorText(bytes);
		if (text === null || text.length > TEXT_MAX_CHARS) return;
		texts.set(id, text);
		textChars += text.length;
		for (const [oldest, value] of texts) {
			if (textChars <= TEXT_CACHE_CHARS) break;
			texts.delete(oldest);
			textChars -= value.length;
		}
	}

	function setBaseline(sessionId: string, key: string, hash: string, at: number): void {
		const session = reads.get(sessionId) ?? new Map<string, Baseline>();
		touch(session, key, { hash, seq: ++seq, at }, BASELINES_PER_SESSION);
		touch(reads, sessionId, session, MAX_SESSIONS);
	}

	function windowAt(mtimeMs: number): BashWindow | undefined {
		const at = now();
		for (let index = windows.length - 1; index >= 0; index--) {
			const window = windows[index];
			if (!window) continue;
			const end = (window.end ?? at) + WINDOW_GRACE_MS;
			if (mtimeMs >= window.start - WINDOW_SLACK_MS && mtimeMs <= end) return window;
		}
		return undefined;
	}

	function recordWrite(input: {
		path: string;
		author: WriteAuthor;
		before: Uint8Array | null;
		after: Uint8Array;
		line?: number;
	}): WriteEntry {
		const key = fileKey(input.path);
		const hash = hashBytes(input.after);
		const at = now();
		const line =
			input.line ?? (input.before === null ? undefined : lineOf(input.before, input.after));
		const entry: WriteEntry = {
			seq: ++seq,
			at,
			path: input.path,
			hash,
			author: input.author,
			...(line === undefined ? {} : { line }),
		};
		const ring = [...(writes.get(key) ?? []), entry].slice(-WRITES_PER_PATH);
		touch(writes, key, ring, MAX_PATHS);
		recent.push(entry);
		if (recent.length > RECENT_WRITES) recent.splice(0, recent.length - RECENT_WRITES);
		if (input.author.kind === "agent") {
			setBaseline(input.author.sessionId, key, hash, at);
			cacheText(key, hash, input.after);
		}
		return entry;
	}

	function recordRead(input: { sessionId: string; path: string; bytes: Uint8Array }): void {
		const key = fileKey(input.path);
		const hash = hashBytes(input.bytes);
		setBaseline(input.sessionId, key, hash, now());
		cacheText(key, hash, input.bytes);
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
			return { path: input.path, baseline: null, writers, untracked: false };
		}
		const currentHash = input.current ? hashBytes(input.current.bytes) : null;
		if (currentHash === baseline.hash) return null;
		const since = entries.filter((entry) => entry.seq > baseline.seq);
		const writers = since.filter((entry) => !isSelf(entry, input.sessionId));
		const untracked = since.at(-1)?.hash !== currentHash;
		const window = untracked && input.current ? windowAt(input.current.mtimeMs) : undefined;
		const baselineText = texts.get(`${key}\n${baseline.hash}`);
		return {
			path: input.path,
			baseline: { hash: baseline.hash, at: baseline.at },
			writers,
			untracked,
			...(window
				? { script: { sessionId: window.sessionId, self: window.sessionId === input.sessionId } }
				: {}),
			...(baselineText === undefined ? {} : { baselineText }),
		};
	}

	function openBashWindow(input: { sessionId: string; toolCallId: string }): void {
		windows.push({ ...input, startSeq: seq, start: now() });
		if (windows.length > MAX_WINDOWS) windows.splice(0, windows.length - MAX_WINDOWS);
	}

	function closeBashWindow(input: {
		sessionId: string;
		toolCallId: string;
	}): { window: BashWindow; userWrites: WriteEntry[] } | null {
		const window = windows.find(
			(candidate) =>
				candidate.sessionId === input.sessionId &&
				candidate.toolCallId === input.toolCallId &&
				candidate.end === undefined,
		);
		if (!window) return null;
		window.end = now();
		window.endSeq = seq;
		const userWrites = recent.filter(
			(entry) => entry.author.kind === "user" && entry.seq > window.startSeq && entry.seq <= seq,
		);
		return { window, userWrites };
	}

	function lastWrite(input: {
		path: string;
		hash: string | null;
		clientKey: string;
	}): FileLastWrite | undefined {
		if (input.hash === null) return undefined;
		const entries = writes.get(fileKey(input.path)) ?? [];
		const hit = entries.findLast((entry) => entry.hash === input.hash);
		if (hit) {
			const author: FileAuthor =
				hit.author.kind === "user"
					? { kind: "user", thisClient: hit.author.clientKey === input.clientKey }
					: hit.author;
			return { author, at: hit.at };
		}
		const mtimeMs = mtimeOf(input.path);
		if (mtimeMs === undefined) return undefined;
		const window = windowAt(mtimeMs);
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
	}

	return {
		now,
		recordWrite,
		recordRead,
		staleRead,
		openBashWindow,
		closeBashWindow,
		lastWrite,
		forgetSession,
	};
}

function lineOf(before: Uint8Array, after: Uint8Array): number | undefined {
	const previous = editorText(before);
	const next = editorText(after);
	if (previous === null || next === null) return undefined;
	return firstChangedLine(previous, next);
}

export type Provenance = ReturnType<typeof createProvenance>;

export const fileProvenance = createProvenance();

export type MutationQueue = <T>(abs: string, run: () => Promise<T>) => Promise<T>;

export function recordingQueue(
	queue: MutationQueue,
	author: WriteAuthor,
	store: Provenance = fileProvenance,
): MutationQueue {
	return <T>(abs: string, run: () => Promise<T>) =>
		queue(abs, async (): Promise<T> => {
			const before = readSnapshot(abs);
			const result = await run();
			const after = readSnapshot(abs);
			if (after && !sameBytes(before?.bytes ?? null, after.bytes)) {
				store.recordWrite({ path: abs, author, before: before?.bytes ?? null, after: after.bytes });
			}
			return result;
		});
}
