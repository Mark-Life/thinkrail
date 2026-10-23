import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	type ExtensionFactory,
	isEditToolResult,
	isToolCallEventType,
	type ToolCallEventResult,
	type ToolResultEvent,
	type ToolResultEventResult,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { logger } from "../log";
import {
	bashNote,
	editorText,
	fileProvenance,
	type Provenance,
	readSnapshot,
	type StaleRead,
	staleEditHint,
	staleWriteBlock,
} from "../provenance";

const log = logger("agent");

const STALE_EDIT_ERROR = /^Could not find (?:the exact text|edits\[\d+\]) in /;
const UNICODE_SPACES = /[  -   　]/g;
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const PENDING_WRITES_MAX = 64;

export function isStaleEditError(text: string): boolean {
	return STALE_EDIT_ERROR.test(text);
}

export function agentPath(path: string, cwd: string): string {
	let normalized = path.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized === "~") return homedir();
	if (normalized.startsWith("~/")) normalized = join(homedir(), normalized.slice(2));
	else if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
	return resolve(cwd, normalized);
}

function displayUnder(cwd: string): (abs: string) => string {
	return (abs) => {
		const rel = relative(cwd, abs);
		if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return abs;
		return rel.split(sep).join("/");
	};
}

function pathInput(input: Record<string, unknown>): string | undefined {
	return typeof input.path === "string" && input.path !== "" ? input.path : undefined;
}

function firstText(content: ToolResultEvent["content"]): string {
	const block = content.find((part) => part.type === "text");
	return block?.type === "text" ? block.text : "";
}

function withNote(event: ToolResultEvent, text: string): ToolResultEventResult {
	return {
		content: [...event.content, { type: "text", text }],
		...(event.structuredContent === undefined
			? {}
			: { structuredContent: event.structuredContent }),
	};
}

function blocksWrite(stale: StaleRead): boolean {
	if (!stale.baseline) return false;
	return stale.writers.length > 0 || (stale.untracked && stale.script?.self !== true);
}

async function safely<T>(label: string, run: () => Promise<T> | T): Promise<T | undefined> {
	try {
		return await run();
	} catch (error) {
		log.warn(`fileGuard ${label} failed`, error);
		return undefined;
	}
}

export function fileGuardExtension(store: Provenance = fileProvenance): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const pendingWrites = new Map<string, Uint8Array | null>();

		function rememberWrite(toolCallId: string, bytes: Uint8Array | null): void {
			pendingWrites.set(toolCallId, bytes);
			for (const oldest of pendingWrites.keys()) {
				if (pendingWrites.size <= PENDING_WRITES_MAX) break;
				pendingWrites.delete(oldest);
			}
		}

		function guardWrite(sessionId: string, toolCallId: string, path: string, cwd: string) {
			const abs = agentPath(path, cwd);
			const current = readSnapshot(abs);
			rememberWrite(toolCallId, current?.bytes ?? null);
			if (!current) return undefined;
			const stale = store.staleRead({ sessionId, path: abs, current });
			if (!stale || !blocksWrite(stale)) return undefined;
			const reason = staleWriteBlock({
				displayPath: path,
				stale,
				currentText: editorText(current.bytes),
				now: store.now(),
			});
			return { block: true, reason } satisfies ToolCallEventResult;
		}

		function recordAgentWrite(input: {
			sessionId: string;
			abs: string;
			toolName: string;
			before: Uint8Array | null;
			line?: number;
		}) {
			return withFileMutationQueue(input.abs, async () => {
				const after = readSnapshot(input.abs);
				if (!after) return;
				store.recordWrite({
					path: input.abs,
					author: {
						kind: "agent",
						sessionId: input.sessionId,
						via: "tool",
						toolName: input.toolName,
					},
					before: input.before,
					after: after.bytes,
					...(input.line === undefined ? {} : { line: input.line }),
				});
			});
		}

		function recordRead(sessionId: string, abs: string) {
			return withFileMutationQueue(abs, async () => {
				const current = readSnapshot(abs);
				if (current) store.recordRead({ sessionId, path: abs, bytes: current.bytes });
			});
		}

		function staleHint(sessionId: string, abs: string, path: string) {
			return withFileMutationQueue(abs, async () => {
				const current = readSnapshot(abs);
				const stale = store.staleRead({ sessionId, path: abs, current });
				if (!stale) return undefined;
				return staleEditHint({
					displayPath: path,
					stale,
					currentText: current ? editorText(current.bytes) : null,
					now: store.now(),
				});
			});
		}

		function shellNote(sessionId: string, event: ToolResultEvent, cwd: string) {
			const userWrites = store.closeBashWindow({ sessionId, toolCallId: event.toolCallId });
			if (!userWrites) return undefined;
			const note = bashNote({
				userWrites,
				displayPath: displayUnder(cwd),
				now: store.now(),
			});
			return note ? withNote(event, note) : undefined;
		}

		pi.on("tool_call", (event, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			if (SHELL_TOOLS.has(event.toolName)) {
				store.openBashWindow({ sessionId, toolCallId: event.toolCallId });
				return undefined;
			}
			if (!isToolCallEventType("write", event)) return undefined;
			const path = pathInput(event.input);
			if (!path) return undefined;
			return safely("write check", () => guardWrite(sessionId, event.toolCallId, path, ctx.cwd));
		});

		pi.on("tool_result", async (event, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			if (SHELL_TOOLS.has(event.toolName)) {
				return safely("shell note", () => shellNote(sessionId, event, ctx.cwd));
			}
			const before = pendingWrites.get(event.toolCallId) ?? null;
			pendingWrites.delete(event.toolCallId);
			const path = pathInput(event.input);
			if (!path) return undefined;
			const abs = agentPath(path, ctx.cwd);
			if (event.toolName === "read") {
				if (!event.isError) await safely("read record", () => recordRead(sessionId, abs));
				return undefined;
			}
			if (event.toolName === "write") {
				if (!event.isError) {
					await safely("write record", () =>
						recordAgentWrite({ sessionId, abs, toolName: "write", before }),
					);
				}
				return undefined;
			}
			if (!isEditToolResult(event)) return undefined;
			if (!event.isError) {
				const line = event.details?.firstChangedLine;
				await safely("edit record", () =>
					recordAgentWrite({
						sessionId,
						abs,
						toolName: "edit",
						before: null,
						...(line === undefined ? {} : { line }),
					}),
				);
				return undefined;
			}
			if (!isStaleEditError(firstText(event.content))) return undefined;
			const hint = await safely("edit hint", () => staleHint(sessionId, abs, path));
			return hint ? withNote(event, hint) : undefined;
		});

		pi.on("session_shutdown", (event, ctx) => {
			if (event.reason !== "reload") store.forgetSession(ctx.sessionManager.getSessionId());
		});
	};
}

export const fileGuard = fileGuardExtension();
