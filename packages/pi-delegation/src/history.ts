import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	type ContextEditEntry,
	parseSessionEntries,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { scanReplayTools } from "./replayTools";
import {
	validAssistantContent,
	validEntry,
	validHeader,
	validThinkingLevel,
	validToolResultContent,
	validUserContent,
} from "./sessionSchema";
import { type CapturedHistory, DelegationError, type HistoryCaptureSource } from "./types";

function invalid(message: string): never {
	throw new DelegationError("invalid-history", message);
}

function validTimestamp(value: string): boolean {
	return Number.isFinite(Date.parse(value));
}

function contextEditContent(target: SessionEntry, replacement: ContextEditEntry["replacement"]) {
	if (replacement === null) return true;
	const { content } = replacement;
	if (target.type === "custom_message") return validUserContent(content);
	if (target.type !== "message") return false;
	switch (target.message.role) {
		case "user":
			return validUserContent(content);
		case "assistant":
			return typeof content === "string" || validAssistantContent(content);
		case "toolResult":
			return typeof content === "string" || validToolResultContent(content);
		default:
			return false;
	}
}

export interface Transcript {
	header: SessionHeader;
	entries: SessionEntry[];
}

export function parseTranscript(jsonl: string, sessionId: string): Transcript {
	if (!jsonl.endsWith("\n")) invalid("Transcript must be newline-ended JSONL");
	const values = parseSessionEntries(jsonl);
	if (values.length !== jsonl.slice(0, -1).split("\n").length)
		invalid("Malformed transcript JSONL");
	const [header, ...rest] = values;
	if (
		!validHeader(header) ||
		header?.type !== "session" ||
		header.version !== 3 ||
		header.id !== sessionId ||
		!validTimestamp(header.timestamp)
	)
		invalid("Invalid pi v3 session header or identity");
	const byId = new Map<string, SessionEntry>();
	const entries: SessionEntry[] = [];
	for (const entry of rest) {
		if (
			!validEntry(entry) ||
			entry.type === "session" ||
			byId.has(entry.id) ||
			!validTimestamp(entry.timestamp) ||
			!(entry.parentId === null || byId.has(entry.parentId)) ||
			(entry.type === "thinking_level_change" && !validThinkingLevel(entry.thinkingLevel))
		) {
			invalid("Invalid entry, duplicate id or broken ancestry");
		}
		if (entry.type === "compaction" && entry.firstKeptEntryId !== entry.id) {
			let ancestor = entry.parentId === null ? undefined : byId.get(entry.parentId);
			while (ancestor && ancestor.id !== entry.firstKeptEntryId) {
				ancestor = ancestor.parentId === null ? undefined : byId.get(ancestor.parentId);
			}
			if (!ancestor) invalid("Compaction firstKeptEntryId is not on its ancestor path");
		}
		if (entry.type === "context_edit") {
			const target = byId.get(entry.targetId);
			let ancestor = entry.parentId === null ? undefined : byId.get(entry.parentId);
			while (ancestor && ancestor.id !== entry.targetId) {
				ancestor = ancestor.parentId === null ? undefined : byId.get(ancestor.parentId);
			}
			if (!target || !ancestor || !contextEditContent(target, entry.replacement))
				invalid("Context edit target or replacement is invalid");
		}
		byId.set(entry.id, entry);
		entries.push(entry);
	}
	return { header, entries };
}

export function branchAt(transcript: Transcript, entryId: string | null): SessionEntry[] {
	if (entryId === null) return [];
	const byId = new Map(transcript.entries.map((entry) => [entry.id, entry]));
	let entry = byId.get(entryId);
	if (!entry) invalid(`Missing cut ${entryId}`);
	const branch: SessionEntry[] = [];
	while (entry) {
		branch.push(entry);
		entry = entry.parentId === null ? undefined : byId.get(entry.parentId);
	}
	return branch.reverse();
}

function digest(jsonl: string): string {
	return createHash("sha256").update(jsonl, "utf8").digest("hex");
}

function serialize(header: SessionHeader, branch: SessionEntry[]): string {
	try {
		return `${[header, ...branch].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	} catch {
		invalid("Session history cannot be serialized as JSONL");
	}
}

export function captureBranch(transcript: Transcript, entryId: string | null): CapturedHistory {
	const branch = branchAt(transcript, entryId);
	const jsonl = serialize(transcript.header, branch);
	const history: CapturedHistory = {
		format: "pi-session-branch-v1",
		sourceSessionId: transcript.header.id,
		entryId,
		sha256: digest(jsonl),
		sizeBytes: Buffer.byteLength(jsonl, "utf8"),
		jsonl,
	};
	validateHistory(history);
	return Object.freeze(history);
}

export function validateHistory(history: CapturedHistory): Transcript {
	if (
		history.format !== "pi-session-branch-v1" ||
		typeof history.jsonl !== "string" ||
		history.sizeBytes !== Buffer.byteLength(history.jsonl, "utf8") ||
		history.sha256 !== digest(history.jsonl) ||
		history.entryId === ""
	)
		invalid("Invalid capture format, boundary, digest or length");
	const transcript = parseTranscript(history.jsonl, history.sourceSessionId);
	const branch = branchAt(transcript, history.entryId);
	if (
		branch.length !== transcript.entries.length ||
		branch.some((entry, index) => entry.id !== transcript.entries[index]?.id)
	) {
		invalid("Capture does not end exactly at its declared cut");
	}
	const { messages } = buildSessionContext(branch, history.entryId);
	const { issues } = scanReplayTools(messages);
	if (issues.length) throw new DelegationError("incomplete-history", issues.join("; "));
	return transcript;
}

export function captureSession(
	source: Extract<HistoryCaptureSource, { kind: "session" }>,
): CapturedHistory {
	const manager = source.sessionManager;
	if (manager.getSessionId() !== source.sessionId) invalid("Session manager identity mismatch");
	const header = manager.getHeader();
	if (!header) throw new DelegationError("history-unavailable", "Source has no session header");
	let entryId: string | null;
	let branch: SessionEntry[];
	if (source.cut.kind === "at-entry") {
		entryId = source.cut.entryId;
		branch = entryId === null ? [] : manager.getBranch(entryId);
	} else {
		branch = parseTranscript(serialize(header, manager.getBranch()), source.sessionId).entries;
		const toolCallId = source.cut.toolCallId;
		const matches = branch.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant"
				? entry.message.content
						.filter((block) => block.type === "toolCall" && block.id === toolCallId)
						.map(() => entry)
				: [],
		);
		if (matches.length !== 1 || !matches[0]) invalid("Missing or ambiguous calling tool batch");
		entryId = matches[0].parentId;
		branch = entryId === null ? [] : manager.getBranch(entryId);
	}
	const jsonl = serialize(header, branch);
	return captureBranch(parseTranscript(jsonl, source.sessionId), entryId);
}

function isAnthropicFamily(message: AssistantMessage): boolean {
	return (
		message.provider.toLowerCase() === "anthropic" ||
		message.api.toLowerCase() === "anthropic-messages" ||
		/claude/i.test(message.model)
	);
}

function removeBoundThinking(manager: SessionManager): void {
	for (const { sourceEntry, messages } of manager.buildSessionProjection().entries) {
		if (sourceEntry.type !== "message" || sourceEntry.message.role !== "assistant") continue;
		const message = messages.find(
			(candidate): candidate is AssistantMessage => candidate.role === "assistant",
		);
		if (!message || !isAnthropicFamily(message)) continue;
		const content = message.content.filter(
			(block) => block.type !== "thinking" || (block.redacted !== true && !block.thinkingSignature),
		);
		if (content.length !== message.content.length)
			manager.appendContextEdit(sourceEntry.id, { content });
	}
}

export function forkCaptured(
	history: CapturedHistory,
	cwd: string,
	sessionDir: string,
): SessionManager {
	validateHistory(history);
	const dir = mkdtempSync(join(tmpdir(), "pi-delegation-seed-"));
	try {
		const file = join(dir, "seed.jsonl");
		writeFileSync(file, history.jsonl, { mode: 0o600, flag: "wx" });
		const manager = SessionManager.forkFrom(file, cwd, sessionDir);
		removeBoundThinking(manager);
		return manager;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
