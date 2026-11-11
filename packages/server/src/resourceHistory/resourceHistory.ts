import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { bool, compile, obj, str } from "@earendil-works/pi-schema";
import type { SessionId, WorkspaceId } from "@thinkrail/contracts";
import {
	compareResourceHistory,
	interruptedResource,
	isLiveResource,
	type ResourceHistoryCursor,
	type ResourceKind,
	ResourceRecord,
	resourceHistoryCursor,
	resourceRecordId,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { errnoCode, hasErrno } from "@thinkrail/shared/errnoCode";
import { logger } from "../log";
import { dataDir, stateFileWriteFailure } from "../persistence";

const log = logger("resource-history");

function unreadable(what: string, error?: unknown): CodedError {
	const errno = error === undefined ? "" : ` (${errnoCode(error) ?? "no error code"})`;
	return new CodedError("STATE_FILE_UNREADABLE", `${what}${errno}`);
}

const STORAGE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/;
const CACHED_CHATS = 64;
const IndexLine = compile(ResourceRecord);
const ArchivedLog = compile(obj({ text: str(), truncated: bool() }, { open: true }));

export interface ResourceHistoryScope {
	workspaceId: WorkspaceId;
	sessionId: SessionId;
}

export interface ArchivedOutput {
	text: string;
	truncated: boolean;
}

interface ChatHistory {
	records: Map<string, ResourceRecord>;
	serialized: Map<string, string>;
	needsNewline: boolean;
}

const cache = new Map<string, ChatHistory>();

/** Drops every loaded index, as a host restart does. */
export function resetResourceHistoryForTests(): void {
	cache.clear();
}

export function resourceHistoryRoot(): string {
	return join(dataDir(), "resource-history");
}

function chatDir(scope: ResourceHistoryScope): string {
	return join(resourceHistoryRoot(), scope.workspaceId, scope.sessionId);
}

function keyOf(record: ResourceRecord): string {
	return `${record.kind}:${resourceRecordId(record)}`;
}

function parseLine(line: string): ResourceRecord | null {
	try {
		const value: unknown = JSON.parse(line);
		return IndexLine.check(value) ? value : null;
	} catch {
		return null;
	}
}

function readIndex(dir: string): ChatHistory {
	const history: ChatHistory = { records: new Map(), serialized: new Map(), needsNewline: false };
	let text: string;
	try {
		text = readFileSync(join(dir, "index.jsonl"), "utf8");
	} catch (error) {
		if (!hasErrno(error, "ENOENT"))
			log.warn("resource history index could not be read", unreadable("index.jsonl", error));
		return history;
	}
	history.needsNewline = text.length > 0 && !text.endsWith("\n");
	let skipped = 0;
	for (const line of text.split("\n")) {
		if (!line) continue;
		const record = parseLine(line);
		if (!record) {
			skipped += 1;
			continue;
		}
		history.records.set(keyOf(record), record);
		history.serialized.set(keyOf(record), JSON.stringify(record.summary));
	}
	if (skipped > 0) {
		log.warn(
			"resource history index skipped lines",
			unreadable(`index.jsonl has ${skipped} unreadable lines`),
		);
	}
	return history;
}

function load(dir: string): ChatHistory {
	let history = cache.get(dir);
	if (history) cache.delete(dir);
	else history = readIndex(dir);
	cache.set(dir, history);
	while (cache.size > CACHED_CHATS) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
	return history;
}

function writeAtomic(path: string, content: string): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, content);
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function recordResource(
	scope: ResourceHistoryScope,
	record: ResourceRecord,
	output?: ArchivedOutput,
): void {
	if (!STORAGE_ID.test(resourceRecordId(record))) return;
	const dir = chatDir(scope);
	try {
		const history = load(dir);
		const key = keyOf(record);
		const serialized = JSON.stringify(record.summary);
		if (history.serialized.get(key) === serialized) return;
		mkdirSync(join(dir, "logs"), { recursive: true });
		if (record.kind === "command" && output && !isLiveResource(record))
			writeAtomic(
				join(dir, "logs", `${resourceRecordId(record)}.json`),
				JSON.stringify({ text: output.text, truncated: output.truncated }),
			);
		const line = `${JSON.stringify({ kind: record.kind, summary: record.summary })}\n`;
		try {
			appendFileSync(join(dir, "index.jsonl"), history.needsNewline ? `\n${line}` : line);
		} catch (error) {
			history.needsNewline = true;
			throw error;
		}
		history.needsNewline = false;
		history.records.set(key, record);
		history.serialized.set(key, serialized);
	} catch (error) {
		log.warn("resource history could not be written", stateFileWriteFailure(dir, error));
	}
}

export function finishedResources(
	scope: ResourceHistoryScope,
	kind: ResourceKind,
	live: ReadonlySet<string>,
): ResourceRecord[] {
	const dir = chatDir(scope);
	const finished: ResourceRecord[] = [];
	for (const record of load(dir).records.values()) {
		if (record.kind !== kind || live.has(resourceRecordId(record))) continue;
		finished.push(
			record.summary.interrupted || isLiveResource(record) ? interruptedResource(record) : record,
		);
	}
	return finished.sort((a, b) =>
		compareResourceHistory(resourceHistoryCursor(a), resourceHistoryCursor(b)),
	);
}

export function pageResources(
	records: readonly ResourceRecord[],
	before: ResourceHistoryCursor | undefined,
	limit: number,
): { items: ResourceRecord[]; hasMore: boolean } {
	const older = before
		? records.filter((record) => compareResourceHistory(before, resourceHistoryCursor(record)) < 0)
		: records;
	return { items: older.slice(0, limit), hasMore: older.length > limit };
}

export function archivedCommandOutput(
	scope: ResourceHistoryScope,
	commandId: string,
): ArchivedOutput | undefined {
	if (!STORAGE_ID.test(commandId)) return undefined;
	const path = join(chatDir(scope), "logs", `${commandId}.json`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (!hasErrno(error, "ENOENT"))
			log.warn("resource history log could not be read", unreadable(`${commandId}.json`, error));
		return undefined;
	}
	if (ArchivedLog.check(parsed)) return { text: parsed.text, truncated: parsed.truncated };
	log.warn(
		"resource history log was refused",
		unreadable(`${commandId}.json is not an archived log`),
	);
	return undefined;
}

export function removeWorkspaceResourceHistory(workspaceId: WorkspaceId): void {
	const dir = join(resourceHistoryRoot(), workspaceId);
	for (const key of [...cache.keys()]) if (key.startsWith(`${dir}${sep}`)) cache.delete(key);
	rmSync(dir, { recursive: true, force: true });
}
