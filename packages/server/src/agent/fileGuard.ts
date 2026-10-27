import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	type ToolCallEventResult,
	type ToolResultEvent,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { logger } from "../log";
import {
	editorText,
	fileProvenance,
	type Provenance,
	readSnapshot,
	staleWriteBlock,
} from "../provenance";

const log = logger("agent");

const ABORTED_ERROR = "Operation aborted";
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const WINDOWS_SHELL_PATH = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i;
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const FILE_TOOLS = new Set(["read", "edit", "write"]);

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

function pathInput(input: Record<string, unknown>): string | undefined {
	return typeof input.path === "string" && input.path !== "" ? input.path : undefined;
}

function firstText(content: ToolResultEvent["content"]): string {
	const block = content.find((part) => part.type === "text");
	return block?.type === "text" ? block.text : "";
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
		// Shutdown can run after dispose() made ctx stale, so it uses the id seen earlier.
		let boundSessionId: string | undefined;
		function sessionOf(ctx: ExtensionContext) {
			boundSessionId = ctx.sessionManager.getSessionId();
			return boundSessionId;
		}

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
					after: after.bytes,
					hash: after.hash,
					toolCallId: input.toolCallId,
					...(input.failed ? { changedOnly: true } : {}),
				});
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

		pi.on("session_start", (_event, ctx) => {
			sessionOf(ctx);
		});

		pi.on("tool_call", (event, ctx) => {
			const sessionId = sessionOf(ctx);
			const { toolCallId, toolName } = event;
			if (SHELL_TOOLS.has(toolName)) {
				return safely("shell window", () => {
					store.openBashWindow({ sessionId, toolCallId, cwd: ctx.cwd });
					return undefined;
				});
			}
			const path = FILE_TOOLS.has(toolName) ? pathInput(event.input) : undefined;
			if (!path) return undefined;
			if (toolName === "write") {
				const abs = agentPath(path, ctx.cwd);
				return safely("write check", () => guardWrite({ sessionId, toolCallId, path, abs }));
			}
			return safely("claim", () => {
				const abs = toolName === "read" ? agentReadPath(path, ctx.cwd) : agentPath(path, ctx.cwd);
				const hash = toolName === "edit" ? (readSnapshot(abs)?.hash ?? null) : null;
				store.openClaim({ sessionId, toolCallId, path: abs, mutates: toolName === "edit", hash });
				return undefined;
			});
		});

		pi.on("tool_result", async (event, ctx) => {
			const sessionId = sessionOf(ctx);
			const { toolCallId } = event;
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
			if (event.toolName !== "edit") return undefined;
			const error = event.isError ? firstText(event.content) : undefined;
			// Every edit error but an abort is thrown before pi writes.
			if (error !== undefined && error !== ABORTED_ERROR) return undefined;
			await safely("edit record", () =>
				recordAgentWrite({
					sessionId,
					toolCallId,
					abs,
					toolName: "edit",
					...(error === undefined ? {} : { failed: {} }),
				}),
			);
			return undefined;
		});

		pi.on("tool_execution_end", (event, ctx) => {
			store.endTool({ sessionId: sessionOf(ctx), toolCallId: event.toolCallId });
		});

		pi.on("session_shutdown", (event) => {
			if (event.reason !== "reload" && boundSessionId) store.forgetSession(boundSessionId);
		});
	};
}

export const fileGuard = fileGuardExtension();
