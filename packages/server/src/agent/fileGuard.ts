import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, posix, relative, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	type ExtensionFactory,
	isEditToolResult,
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
const WINDOWS_SHELL_PATH = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i;
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const FILE_TOOLS = new Set(["read", "edit", "write"]);

export function isStaleEditError(text: string): boolean {
	return STALE_EDIT_ERROR.test(text);
}

function windowsShellPath(path: string): string {
	if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path;
	const match = path.match(WINDOWS_SHELL_PATH);
	if (!match?.[1]) return path;
	return `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

function normalized(path: string, platform: NodeJS.Platform): string {
	const native = platform === "win32" ? windowsShellPath(path) : path;
	const paths = platform === "win32" ? win32 : posix;
	if (native === "~") return homedir();
	if (native.startsWith("~/") || (platform === "win32" && native.startsWith("~\\"))) {
		return paths.join(homedir(), native.slice(2));
	}
	return native.startsWith("file://") ? fileURLToPath(native) : native;
}

export function agentPath(
	path: string,
	cwd: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const spaced = path.replace(UNICODE_SPACES, " ");
	const target = normalized(spaced.startsWith("@") ? spaced.slice(1) : spaced, platform);
	const paths = platform === "win32" ? win32 : posix;
	return paths.isAbsolute(target)
		? paths.resolve(target)
		: paths.resolve(normalized(cwd, platform), target);
}

const curlyQuotes = (path: string) => path.replace(/'/g, "’");

export function agentReadPath(path: string, cwd: string): string {
	const resolved = agentPath(path, cwd);
	const nfd = resolved.normalize("NFD");
	const variants = [
		resolved,
		resolved.replace(/ (AM|PM)\./gi, " $1."),
		nfd,
		curlyQuotes(resolved),
		curlyQuotes(nfd),
	];
	return variants.find((variant) => existsSync(variant)) ?? resolved;
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
	if (!stale.read) return false;
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
		function guardWrite(input: {
			sessionId: string;
			toolCallId: string;
			path: string;
			abs: string;
		}) {
			const current = readSnapshot(input.abs);
			const stale = current
				? store.staleRead({ sessionId: input.sessionId, path: input.abs, current })
				: null;
			if (current && stale && blocksWrite(stale)) {
				const reason = staleWriteBlock({
					displayPath: input.path,
					stale,
					currentText: editorText(current.bytes),
					now: store.now(),
				});
				return { block: true, reason } satisfies ToolCallEventResult;
			}
			store.openClaim({
				sessionId: input.sessionId,
				toolCallId: input.toolCallId,
				path: input.abs,
				mutates: true,
				bytes: current?.bytes ?? null,
			});
			return undefined;
		}

		function recordAgentWrite(input: {
			sessionId: string;
			toolCallId: string;
			abs: string;
			toolName: string;
			line?: number;
			failed?: { content?: string };
		}) {
			return withFileMutationQueue(input.abs, async () => {
				const after = readSnapshot(input.abs);
				if (!after) return;
				const content = input.failed?.content;
				if (content !== undefined && !Buffer.from(content, "utf8").equals(after.bytes)) return;
				store.recordWrite({
					path: input.abs,
					author: {
						kind: "agent",
						sessionId: input.sessionId,
						via: "tool",
						toolName: input.toolName,
					},
					before: null,
					after: after.bytes,
					toolCallId: input.toolCallId,
					...(input.failed ? { changedOnly: true } : {}),
					...(input.line === undefined ? {} : { line: input.line }),
				});
			});
		}

		function recordRead(sessionId: string, toolCallId: string, abs: string) {
			return withFileMutationQueue(abs, async () => {
				const current = readSnapshot(abs);
				if (current) store.recordRead({ sessionId, toolCallId, path: abs, bytes: current.bytes });
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
			const { toolCallId, toolName } = event;
			if (SHELL_TOOLS.has(toolName)) {
				store.openBashWindow({ sessionId, toolCallId, cwd: ctx.cwd });
				return undefined;
			}
			const path = FILE_TOOLS.has(toolName) ? pathInput(event.input) : undefined;
			if (!path) return undefined;
			if (toolName === "write") {
				const abs = agentPath(path, ctx.cwd);
				return safely("write check", () => guardWrite({ sessionId, toolCallId, path, abs }));
			}
			const abs = toolName === "read" ? agentReadPath(path, ctx.cwd) : agentPath(path, ctx.cwd);
			const bytes = toolName === "edit" ? (readSnapshot(abs)?.bytes ?? null) : null;
			store.openClaim({ sessionId, toolCallId, path: abs, mutates: toolName === "edit", bytes });
			return undefined;
		});

		pi.on("tool_result", async (event, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			const { toolCallId } = event;
			if (SHELL_TOOLS.has(event.toolName)) {
				return safely("shell note", () => shellNote(sessionId, event, ctx.cwd));
			}
			const path = pathInput(event.input);
			if (!path) return undefined;
			if (event.toolName === "read") {
				const abs = agentReadPath(path, ctx.cwd);
				if (!event.isError)
					await safely("read record", () => recordRead(sessionId, toolCallId, abs));
				return undefined;
			}
			const abs = agentPath(path, ctx.cwd);
			if (event.toolName === "write") {
				const content = typeof event.input.content === "string" ? event.input.content : "";
				await safely("write record", () =>
					recordAgentWrite({
						sessionId,
						toolCallId,
						abs,
						toolName: "write",
						...(event.isError ? { failed: { content } } : {}),
					}),
				);
				return undefined;
			}
			if (!isEditToolResult(event)) return undefined;
			const stale = event.isError && isStaleEditError(firstText(event.content));
			if (!stale) {
				const line = event.isError ? undefined : event.details?.firstChangedLine;
				await safely("edit record", () =>
					recordAgentWrite({
						sessionId,
						toolCallId,
						abs,
						toolName: "edit",
						...(event.isError ? { failed: {} } : {}),
						...(line === undefined ? {} : { line }),
					}),
				);
				return undefined;
			}
			const hint = await safely("edit hint", () => staleHint(sessionId, abs, path));
			return hint ? withNote(event, hint) : undefined;
		});

		pi.on("tool_execution_end", (event, ctx) => {
			store.endTool({ sessionId: ctx.sessionManager.getSessionId(), toolCallId: event.toolCallId });
		});

		pi.on("session_shutdown", (event, ctx) => {
			if (event.reason !== "reload") store.forgetSession(ctx.sessionManager.getSessionId());
		});
	};
}

export const fileGuard = fileGuardExtension();
