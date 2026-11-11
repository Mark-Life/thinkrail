import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
	AssistantMessage,
	JsonValue,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type {
	SessionEntry,
	SessionHeader,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

type AssistantBody =
	| { text: string; content?: never }
	| ({ text?: never } & Pick<AssistantMessage, "content">);

export type FixtureAssistantInput = Pick<AssistantMessage, "timestamp"> &
	Partial<Pick<AssistantMessage, "stopReason" | "errorMessage">> &
	AssistantBody;

export type FixtureUserInput = Pick<UserMessage, "timestamp"> & { text: string };

/** A tool result whose `details` may be any value: the fixture stores its JSON form, as pi does. */
export type FixtureToolResultInput = Omit<ToolResultMessage, "role" | "details"> & {
	details?: unknown;
};

export type FixtureMessage =
	| ({ role: "user" } & FixtureUserInput)
	| ({ role: "assistant" } & FixtureAssistantInput)
	| ({ role: "toolResult" } & FixtureToolResultInput);

const zeroUsage = (): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** A complete pi assistant message, as a real provider reply records it. */
export const fixtureAssistant = ({
	stopReason = "stop",
	errorMessage,
	timestamp,
	...body
}: FixtureAssistantInput): AssistantMessage => ({
	role: "assistant",
	content: body.text === undefined ? body.content : [{ type: "text", text: body.text }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-fixture",
	usage: zeroUsage(),
	stopReason,
	...(errorMessage === undefined ? {} : { errorMessage }),
	timestamp,
});

export const fixtureUser = ({ text, timestamp }: FixtureUserInput): UserMessage => ({
	role: "user",
	content: text,
	timestamp,
});

const jsonValue = (value: unknown): JsonValue => {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (Array.isArray(value)) return value.map(jsonValue);
	if (typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).flatMap(([key, field]) =>
				field === undefined ? [] : [[key, jsonValue(field)]],
			),
		);
	throw new TypeError(`Fixture value is not JSON: ${typeof value}`);
};

export const fixtureToolResult = ({
	details,
	...result
}: FixtureToolResultInput): ToolResultMessage => ({
	role: "toolResult",
	...result,
	...(details === undefined ? {} : { details: jsonValue(details) }),
});

const fixtureMessage = (message: FixtureMessage): SessionMessageEntry["message"] => {
	if (message.role === "user") return fixtureUser(message);
	if (message.role === "assistant") return fixtureAssistant(message);
	return fixtureToolResult(message);
};

/** A pi message entry, timestamped from its message. */
export const fixtureMessageEntry = (
	id: string,
	parentId: string | null,
	message: SessionMessageEntry["message"],
): SessionMessageEntry => ({
	type: "message",
	id,
	parentId,
	timestamp: new Date(message.timestamp).toISOString(),
	message,
});

const jsonl = (lines: readonly (SessionHeader | SessionEntry)[]) =>
	`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;

/** Appends entries to an existing fixture session, as pi appends to a live transcript. */
export function appendFixtureEntries(path: string, entries: SessionEntry[]): void {
	appendFileSync(path, jsonl(entries));
}

export function writeFixtureSession(
	dir: string,
	opts: {
		id?: string;
		cwd: string;
		name?: string;
		messages: FixtureMessage[];
	},
): { id: string; path: string } {
	mkdirSync(dir, { recursive: true });

	const sessionId = opts.id ?? `sess-${randomUUID()}`;
	const entryId = (suffix: string) => `${sessionId}-${suffix}`;
	const header: SessionHeader = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: new Date(opts.messages[0]?.timestamp ?? Date.now()).toISOString(),
		cwd: opts.cwd,
	};
	const entries: SessionEntry[] = [];
	let parentId: string | null = null;

	if (opts.name !== undefined) {
		const id = entryId("info");
		entries.push({
			type: "session_info",
			id,
			parentId,
			timestamp: new Date().toISOString(),
			name: opts.name,
		});
		parentId = id;
	}

	opts.messages.forEach((message, index) => {
		const id = entryId(`m${index}`);
		entries.push(fixtureMessageEntry(id, parentId, fixtureMessage(message)));
		parentId = id;
	});

	const path = join(dir, `${opts.messages[0]?.timestamp ?? Date.now()}_${sessionId}.jsonl`);
	writeFileSync(path, jsonl([header, ...entries]));
	return { id: sessionId, path };
}

export function defaultSessionDirFor(agentDir: string, cwd: string): string {
	const resolvedCwd = resolve(cwd);
	const resolvedAgentDir = resolve(agentDir);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(resolvedAgentDir, "sessions", safePath);
}
