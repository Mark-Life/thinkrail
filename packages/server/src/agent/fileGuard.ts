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
	overwriteNote,
	type Provenance,
	readSnapshot,
	staleEditHint,
	staleWriteBlock,
} from "../provenance";

const log = logger("agent");

const STALE_EDIT_ERROR = /^Could not find (?:the exact text|edits\[\d+\]) in /;
const ABORTED_ERROR = "Operation aborted";
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
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
		resolved.replace(/ (AM|PM)\./gi, "\u202F$1."),
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
			const stale =
				current || !existsSync(input.abs)
					? store.staleRead({ sessionId: input.sessionId, path: input.abs, current })
					: null;
			if (stale?.read) {
				const reason = staleWriteBlock({
					displayPath: input.path,
					stale,
					currentText: current ? editorText(current.bytes) : null,
					now: store.now(),
					deleted: current === null,
				});
				return { block: true, reason } satisfies ToolCallEventResult;
			}
			store.openClaim({
				sessionId: input.sessionId,
				toolCallId: input.toolCallId,
				path: input.abs,
				mutates: true,
				hash: current?.hash ?? null,
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
				if (!after) return undefined;
				const content = input.failed?.content;
				if (content !== undefined && !Buffer.from(content, "utf8").equals(after.bytes)) {
					return undefined;
				}
				const overwrite = store.recordWrite({
					path: input.abs,
					author: {
						kind: "agent",
						sessionId: input.sessionId,
						via: "tool",
						toolName: input.toolName,
					},
					before: null,
					after: after.bytes,
					hash: after.hash,
					toolCallId: input.toolCallId,
					...(input.failed ? { changedOnly: true } : {}),
					...(input.line === undefined ? {} : { line: input.line }),
				});
				return overwrite && { overwrite, after: after.bytes };
			});
		}

		function recordRead(sessionId: string, toolCallId: string, abs: string, failed: boolean) {
			return withFileMutationQueue(abs, async () => {
				if (failed) {
					if (!existsSync(abs)) store.recordRead({ sessionId, toolCallId, path: abs, bytes: null });
					return;
				}
				const current = readSnapshot(abs);
				if (!current) return;
				const { bytes, hash } = current;
				store.recordRead({ sessionId, toolCallId, path: abs, bytes, hash });
			});
		}

		async function staleHint(sessionId: string, abs: string, path: string) {
			const found = await withFileMutationQueue(abs, async () => {
				const current = readSnapshot(abs);
				const stale = store.staleRead({ sessionId, path: abs, current });
				return stale && { stale, current };
			});
			if (!found) return undefined;
			return staleEditHint({
				displayPath: path,
				stale: found.stale,
				currentText: found.current ? editorText(found.current.bytes) : null,
				now: store.now(),
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
			const hash = toolName === "edit" ? (readSnapshot(abs)?.hash ?? null) : null;
			store.openClaim({ sessionId, toolCallId, path: abs, mutates: toolName === "edit", hash });
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
				await safely("read record", () => recordRead(sessionId, toolCallId, abs, event.isError));
				return undefined;
			}
			const abs = agentPath(path, ctx.cwd);
			if (event.toolName === "write") {
				const content = typeof event.input.content === "string" ? event.input.content : "";
				const replaced = await safely("write record", () =>
					recordAgentWrite({
						sessionId,
						toolCallId,
						abs,
						toolName: "write",
						...(event.isError ? { failed: { content } } : {}),
					}),
				);
				if (!replaced) return undefined;
				const note = overwriteNote({
					displayPath: path,
					overwrite: replaced.overwrite,
					currentText: editorText(replaced.after),
					now: store.now(),
				});
				return withNote(event, note);
			}
			if (!isEditToolResult(event)) return undefined;
			const error = event.isError ? firstText(event.content) : undefined;
			if (error !== undefined && isStaleEditError(error)) {
				const hint = await safely("edit hint", () => staleHint(sessionId, abs, path));
				return hint ? withNote(event, hint) : undefined;
			}
			// Every other edit error but an abort is thrown before pi writes.
			if (error !== undefined && error !== ABORTED_ERROR) return undefined;
			const line = error === undefined ? event.details?.firstChangedLine : undefined;
			await safely("edit record", () =>
				recordAgentWrite({
					sessionId,
					toolCallId,
					abs,
					toolName: "edit",
					...(error === undefined ? {} : { failed: {} }),
					...(line === undefined ? {} : { line }),
				}),
			);
			return undefined;
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
