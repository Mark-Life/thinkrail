import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Hash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createEditTool,
	createReadTool,
	createWriteTool,
	type ToolCallEventResult,
	type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { hashBytes } from "../fs";
import { createProvenance, type Provenance } from "../provenance";
import { agentPath, agentReadPath, fileGuardExtension, isStaleEditError } from "./fileGuard";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface ToolOutcome {
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
	content: { type: "text"; text: string }[];
	details: unknown;
	isError: boolean;
}

interface PiTool {
	name: string;
	execute: (
		toolCallId: string,
		params: never,
		signal?: AbortSignal,
	) => Promise<{ content: ToolOutcome["content"]; details: unknown }>;
}

let root: string;
let store: Provenance;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "trpi-file-guard-"));
	store = createProvenance();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function guard(sessionId = "s1") {
	const handlers = new Map<string, Handler>();
	fileGuardExtension(store)({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
	} as never);
	const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
	const emit = (name: string, event: object) => handlers.get(name)?.(event, ctx);
	return {
		call: async (toolName: string, toolCallId: string, input: Record<string, unknown>) =>
			(await emit("tool_call", { type: "tool_call", toolName, toolCallId, input })) as
				| ToolCallEventResult
				| undefined,
		result: async (outcome: ToolOutcome) =>
			(await emit("tool_result", { type: "tool_result", ...outcome })) as
				| ToolResultEventResult
				| undefined,
		end: (toolCallId: string) =>
			emit("tool_execution_end", { type: "tool_execution_end", toolCallId, isError: true }),
		shutdown: (reason: string) => emit("session_shutdown", { type: "session_shutdown", reason }),
	};
}

async function run(
	tool: PiTool,
	toolCallId: string,
	input: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ToolOutcome> {
	const base = { toolName: tool.name, toolCallId, input };
	try {
		const result = await tool.execute(toolCallId, input as never, signal);
		return { ...base, content: result.content, details: result.details, isError: false };
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		return { ...base, content: [{ type: "text", text }], details: undefined, isError: true };
	}
}

const read = (path: string, toolCallId = `read-${path}`) =>
	run(createReadTool(root) as PiTool, toolCallId, { path });
const edit = (path: string, oldText: string, newText: string, toolCallId = `edit-${path}`) =>
	run(createEditTool(root) as PiTool, toolCallId, { path, edits: [{ oldText, newText }] });
const write = (toolCallId: string, path: string, content: string) =>
	run(createWriteTool(root) as PiTool, toolCallId, { path, content });

function userSave(name: string, content: string): void {
	const path = join(root, name);
	const before = readFileSync(path);
	writeFileSync(path, content);
	store.recordWrite({
		path,
		author: { kind: "user", clientKey: "c" },
		before,
		after: readFileSync(path),
	});
}

function texts(result: ToolResultEventResult | undefined): string[] {
	return (result?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : []));
}

test("pi's not-found edit errors, single and multi, are the ones recognized", async () => {
	writeFileSync(join(root, "a.ts"), "alpha\nbeta\nalpha\n");
	const single = await edit("a.ts", "missing", "x");
	const multi = await run(createEditTool(root) as PiTool, "m", {
		path: "a.ts",
		edits: [
			{ oldText: "beta", newText: "b" },
			{ oldText: "missing", newText: "x" },
		],
	});
	const duplicate = await edit("a.ts", "alpha", "x");
	expect(single.isError && isStaleEditError(single.content[0]?.text ?? "")).toBe(true);
	expect(multi.isError && isStaleEditError(multi.content[0]?.text ?? "")).toBe(true);
	expect(duplicate.isError).toBe(true);
	expect(isStaleEditError(duplicate.content[0]?.text ?? "")).toBe(false);
});

test("agentPath resolves like pi's tools: @, ~, Unicode spaces, file:// and Windows shell paths", () => {
	expect(agentPath("@src/a.ts", root)).toBe(join(root, "src/a.ts"));
	expect(agentPath("~/x.ts", root)).toBe(join(homedir(), "x.ts"));
	expect(agentPath("/abs/x.ts", root)).toBe("/abs/x.ts");
	expect(agentPath("a\u00A0b\u202Fc.ts", root)).toBe(join(root, "a b c.ts"));
	expect(agentPath(pathToFileURL(join(root, "u.ts")).href, "/elsewhere")).toBe(join(root, "u.ts"));
	expect(agentPath("/c/Users/x/a.ts", "C:\\w", "win32")).toBe("C:\\Users\\x\\a.ts");
	expect(agentPath("/mnt/d/a.ts", "C:\\w", "win32")).toBe("D:\\a.ts");
	expect(agentPath("/cygdrive/c/a.ts", "C:\\w", "win32")).toBe("C:\\a.ts");
	expect(agentPath("~\\a.ts", "C:\\w", "win32")).toBe(win32.resolve(homedir(), "a.ts"));
	expect(agentPath("src\\a.ts", "/c/w", "win32")).toBe("C:\\w\\src\\a.ts");
});

test("agentReadPath falls back to the spelling variants pi's read tries", () => {
	writeFileSync(join(root, "d\u2019x.txt"), "x\n");
	writeFileSync(join(root, "Shot 1.02 PM.png"), "");
	writeFileSync(join(root, "Shot 1.03\u202FPM.png"), "");
	expect(agentReadPath("d'x.txt", root)).toBe(join(root, "d\u2019x.txt"));
	expect(agentReadPath("Shot 1.02 PM.png", root)).toBe(join(root, "Shot 1.02 PM.png"));
	expect(agentReadPath("Shot 1.03 PM.png", root)).toBe(join(root, "Shot 1.03\u202FPM.png"));
	expect(agentReadPath("missing.txt", root)).toBe(join(root, "missing.txt"));
});

test("agentPath and agentReadPath land on the files pi's own write and read tools use", async () => {
	const spellings = [
		"@at.ts",
		`~/${relative(homedir(), join(root, "home.ts"))}`,
		"no\u00A0break\u202Fspace.ts",
		pathToFileURL(join(root, "url.ts")).href,
		join(root, "abs.ts"),
	];
	for (const [index, path] of spellings.entries()) {
		const content = `written ${index}\n`;
		expect((await write(`w${index}`, path, content)).isError).toBe(false);
		expect(readFileSync(agentPath(path, root), "utf8")).toBe(content);
	}
	writeFileSync(join(root, "d\u2019x.txt"), "curly\n");
	writeFileSync(join(root, "Shot 1.03\u202FPM.txt"), "screenshot\n");
	for (const path of [...spellings, "d'x.txt", "Shot 1.03 PM.txt"]) {
		const fromPi = await read(path);
		expect(fromPi.isError).toBe(false);
		expect(fromPi.content[0]?.text).toContain(readFileSync(agentReadPath(path, root), "utf8"));
	}
});

test("a stale write is blocked when the read went through a spelling variant", async () => {
	writeFileSync(join(root, "d\u2019x.txt"), "one\n");
	const guarded = guard();
	await guarded.result(await read("d'x.txt"));
	userSave("d\u2019x.txt", "mine\n");
	const blocked = await guarded.call("write", "w1", { path: "d\u2019x.txt", content: "x\n" });
	expect(blocked?.block).toBe(true);
});

test("an edit that fails after the user changed the file gets the pointer and the user's diff", async () => {
	writeFileSync(join(root, "a.ts"), "const ttl = 60;\nexport {};\n");
	const guarded = guard();
	expect(await guarded.result(await read("a.ts"))).toBeUndefined();
	userSave("a.ts", "const ttl = 3600;\nexport {};\n");

	const failed = await edit("a.ts", "const ttl = 60;", "const ttl = 120;");
	expect(failed.isError).toBe(true);
	const result = await guarded.result(failed);
	const [piError, hint] = texts(result);
	expect(piError).toBe(failed.content[0]?.text);
	expect(result?.isError).toBeUndefined();
	expect(hint).toStartWith(
		"ThinkRail: a.ts was changed by the user 0 s ago (line 1) since you last read it. Re-read the file before editing.",
	);
	expect(hint).toContain("-const ttl = 60;\n+const ttl = 3600;");
});

test("an edit that fails with no change since the read gets no hint", async () => {
	writeFileSync(join(root, "a.ts"), "one\n");
	const guarded = guard();
	await guarded.result(await read("a.ts"));
	expect(await guarded.result(await edit("a.ts", "two", "three"))).toBeUndefined();
});

test("a successful edit and write are recorded as the agent and move its baseline", async () => {
	writeFileSync(join(root, "a.ts"), "one\ntwo\n");
	const guarded = guard();
	await guarded.result(await read("a.ts"));
	await guarded.result(await edit("a.ts", "two", "TWO"));
	const edited = readFileSync(join(root, "a.ts"));
	expect(
		store.lastWrite({ path: join(root, "a.ts"), hash: hashBytes(edited), clientKey: "c" }),
	).toMatchObject({ author: { kind: "agent", sessionId: "s1", via: "tool", toolName: "edit" } });

	expect(await guarded.call("write", "w1", { path: "a.ts", content: "new\n" })).toBeUndefined();
	await guarded.result(await write("w1", "a.ts", "new\n"));
	const entry = store.lastWrite({
		path: join(root, "a.ts"),
		hash: hashBytes(readFileSync(join(root, "a.ts"))),
		clientKey: "c",
	});
	expect(entry?.author).toMatchObject({ kind: "agent", toolName: "write" });
});

test("a whole-file write after a stale read is blocked; a file never read is not", async () => {
	writeFileSync(join(root, "read.ts"), "one\n");
	writeFileSync(join(root, "unread.ts"), "one\n");
	const guarded = guard();
	await guarded.result(await read("read.ts"));
	userSave("read.ts", "mine\n");
	userSave("unread.ts", "mine\n");

	const blocked = await guarded.call("write", "w1", { path: "read.ts", content: "theirs\n" });
	expect(blocked?.block).toBe(true);
	expect(blocked?.reason).toStartWith(
		"Blocked: read.ts changed since you read it (by the user 0 s ago). Re-read before writing.",
	);
	expect(blocked?.reason).toContain("-one\n+mine");
	expect(await guarded.call("write", "w2", { path: "unread.ts", content: "x\n" })).toBeUndefined();

	await guarded.result(await read("read.ts"));
	expect(await guarded.call("write", "w3", { path: "read.ts", content: "x\n" })).toBeUndefined();
});

test("another session's write is not this session's own: it is reported and blocks", async () => {
	writeFileSync(join(root, "a.ts"), "one\n");
	const first = guard("s1");
	const second = guard("s2");
	await first.result(await read("a.ts"));
	await second.result(await edit("a.ts", "one", "two"));
	const blocked = await first.call("write", "w1", { path: "a.ts", content: "x\n" });
	expect(blocked?.reason).toStartWith(
		"Blocked: a.ts changed since you read it (by another agent 0 s ago).",
	);
});

test("a change during the session's own shell command still blocks, since an outside save looks the same", async () => {
	writeFileSync(join(root, "a.ts"), "one\n");
	const guarded = guard();
	await guarded.result(await read("a.ts"));
	await guarded.call("bash", "b1", { command: "bun test" });
	writeFileSync(join(root, "a.ts"), "typed in another editor\n");
	const blocked = await guarded.call("write", "w1", { path: "a.ts", content: "x\n" });
	expect(blocked?.reason).toStartWith(
		"Blocked: a.ts changed since you read it (by your own shell command, a terminal command or a program outside ThinkRail).",
	);
	await guarded.result(await read("a.ts", "r2"));
	expect(await guarded.call("write", "w2", { path: "a.ts", content: "x\n" })).toBeUndefined();
});

test("a bash result notes the files the user saved during the call", async () => {
	writeFileSync(join(root, "a.ts"), "one\ntwo\n");
	const guarded = guard();
	const bash = {
		toolName: "bash",
		toolCallId: "b1",
		input: { command: "bun test" },
		content: [{ type: "text" as const, text: "1 fail" }],
		details: undefined,
		isError: true,
	};
	await guarded.call("bash", "b1", bash.input);
	userSave("a.ts", "one\nTWO\n");
	expect(texts(await guarded.result(bash))).toEqual([
		"1 fail",
		"Note: the user edited a.ts 0 s ago during this call (line 2).",
	]);

	await guarded.call("bash", "b2", bash.input);
	expect(await guarded.result({ ...bash, toolCallId: "b2" })).toBeUndefined();
});

test("shutdown forgets the session's reads, except across a reload", async () => {
	writeFileSync(join(root, "a.ts"), "one\n");
	const guarded = guard();
	await guarded.result(await read("a.ts"));
	userSave("a.ts", "two\n");
	await guarded.shutdown("reload");
	expect((await guarded.call("write", "w1", { path: "a.ts", content: "x\n" }))?.block).toBe(true);
	await guarded.shutdown("quit");
	expect(await guarded.call("write", "w2", { path: "a.ts", content: "x\n" })).toBeUndefined();
});

test("two agents editing one file at once: the first one's later write over the other's edit is blocked", async () => {
	writeFileSync(join(root, "a.ts"), "one\ntwo\n");
	const first = guard("s1");
	const second = guard("s2");
	await first.call("read", "r1", { path: "a.ts" });
	await first.result(await read("a.ts", "r1"));
	await first.call("edit", "e1", { path: "a.ts" });
	await second.call("edit", "e2", { path: "a.ts" });
	const editing = edit("a.ts", "one", "ONE", "e1");
	const other = edit("a.ts", "two", "TWO", "e2");
	await first.result(await editing);
	await second.result(await other);
	expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("ONE\nTWO\n");

	const blocked = await first.call("write", "w1", { path: "a.ts", content: "ONE\ntwo\n" });
	expect(blocked?.reason).toStartWith(
		"Blocked: a.ts changed since you read it (by another agent 0 s ago).",
	);
	expect(
		store.lastWrite({
			path: join(root, "a.ts"),
			hash: hashBytes(readFileSync(join(root, "a.ts"))),
			clientKey: "c",
		})?.author,
	).toMatchObject({ kind: "agent", sessionId: "s2" });
});

test("a user save between pi's read and its result is not adopted as what the agent read", async () => {
	writeFileSync(join(root, "a.ts"), "one\n");
	const guarded = guard();
	await guarded.call("read", "r1", { path: "a.ts" });
	const result = await read("a.ts", "r1");
	userSave("a.ts", "mine\n");
	await guarded.result(result);
	const blocked = await guarded.call("write", "w1", { path: "a.ts", content: "x\n" });
	expect(blocked?.reason).toStartWith(
		"Blocked: a.ts changed since you read it (by the user 0 s ago).",
	);
});

test("a write or edit that pi aborts after writing is still recorded as the agent", async () => {
	writeFileSync(join(root, "a.ts"), "one\n");
	writeFileSync(join(root, "b.ts"), "one\n");
	const guarded = guard();
	const abortAfterWrite = () => {
		const controller = new AbortController();
		const writeFileThenAbort = async (path: string, content: string) => {
			await writeFile(path, content, "utf-8");
			controller.abort();
		};
		return { signal: controller.signal, writeFileThenAbort };
	};

	await guarded.result(await read("a.ts"));
	expect(await guarded.call("write", "w1", { path: "a.ts", content: "agent\n" })).toBeUndefined();
	const writing = abortAfterWrite();
	const tool = createWriteTool(root, {
		operations: { writeFile: writing.writeFileThenAbort, mkdir: async () => undefined },
	});
	const aborted = await run(
		tool as PiTool,
		"w1",
		{ path: "a.ts", content: "agent\n" },
		writing.signal,
	);
	expect(aborted.isError).toBe(true);
	await guarded.result(aborted);
	await guarded.end("w1");
	expect(await guarded.call("write", "w2", { path: "a.ts", content: "x\n" })).toBeUndefined();

	await guarded.result(await read("b.ts"));
	await guarded.call("edit", "e1", { path: "b.ts" });
	const editing = abortAfterWrite();
	const editTool = createEditTool(root, {
		operations: {
			readFile: (path) => Promise.resolve(readFileSync(path)),
			writeFile: editing.writeFileThenAbort,
			access: async () => undefined,
		},
	});
	const input = { path: "b.ts", edits: [{ oldText: "one", newText: "agent" }] };
	const abortedEdit = await run(editTool as PiTool, "e1", input, editing.signal);
	expect(abortedEdit.isError).toBe(true);
	await guarded.result(abortedEdit);
	expect(
		store.lastWrite({
			path: join(root, "b.ts"),
			hash: hashBytes(readFileSync(join(root, "b.ts"))),
			clientKey: "c",
		})?.author,
	).toMatchObject({ kind: "agent", toolName: "edit" });
	expect(await guarded.call("write", "w3", { path: "b.ts", content: "x\n" })).toBeUndefined();
});

test("an edit that fails before writing does not take an outside change as the agent's", async () => {
	writeFileSync(join(root, "a.ts"), "x\nx\nkeep\n");
	const guarded = guard();
	await guarded.result(await read("a.ts"));
	await guarded.call("edit", "e1", { path: "a.ts" });
	writeFileSync(join(root, "a.ts"), "x\nx\nkeep\noutside\n");
	const failed = await edit("a.ts", "x", "y", "e1");
	expect(failed.content[0]?.text).toStartWith("Found 2 occurrences");
	expect(await guarded.result(failed)).toBeUndefined();
	await guarded.end("e1");
	const current = readFileSync(join(root, "a.ts"));
	expect(
		store.lastWrite({ path: join(root, "a.ts"), hash: hashBytes(current), clientKey: "c" }),
	).toBeUndefined();
	const blocked = await guarded.call("write", "w1", { path: "a.ts", content: "x\n" });
	expect(blocked?.reason).toStartWith(
		"Blocked: a.ts changed since you read it (by a terminal command or a program outside ThinkRail).",
	);
});

test("an edit over a save made after its claim decodes nothing, since edits get no overwrite note", async () => {
	writeFileSync(join(root, "a.ts"), "one\ntwo\n");
	const guarded = guard();
	await guarded.result(await read("a.ts"));
	await guarded.call("edit", "e1", { path: "a.ts" });
	userSave("a.ts", "one\ntwo\nuser\n");
	const edited = await edit("a.ts", "two", "TWO", "e1");
	const decode = spyOn(TextDecoder.prototype, "decode");
	try {
		expect(await guarded.result(edited)).toBeUndefined();
		expect(decode).not.toHaveBeenCalled();
	} finally {
		decode.mockRestore();
	}
});

test("a bash call that never gets a result is closed when pi ends the tool", async () => {
	let offset = 0;
	store = createProvenance({ now: () => Date.now() + offset });
	writeFileSync(join(root, "a.ts"), "one\n");
	const guarded = guard();
	await guarded.result(await read("a.ts"));
	await guarded.call("bash", "b1", { command: "x" });
	await guarded.end("b1");
	offset = 60 * 60 * 1000;
	writeFileSync(join(root, "a.ts"), "outside\n");
	const later = new Date(Date.now() + offset);
	utimesSync(join(root, "a.ts"), later, later);
	const blocked = await guarded.call("write", "w1", { path: "a.ts", content: "x\n" });
	expect(blocked?.reason).toContain("(by a terminal command or a program outside ThinkRail)");
});

test("a whole-file write records the first line it changed", async () => {
	writeFileSync(join(root, "a.ts"), "one\ntwo\nthree\n");
	const first = guard("s1");
	const second = guard("s2");
	await second.result(await read("a.ts"));
	await first.result(await read("a.ts"));
	expect(
		await first.call("write", "w1", { path: "a.ts", content: "one\ntwo\nTHREE\n" }),
	).toBeUndefined();
	await first.result(await write("w1", "a.ts", "one\ntwo\nTHREE\n"));
	const failed = await second.result(await edit("a.ts", "three", "3"));
	expect(texts(failed)[1]).toStartWith(
		"ThinkRail: a.ts was changed by another agent 0 s ago (line 3)",
	);
});

test("a write over a file deleted since the read is blocked until a read confirms it is gone", async () => {
	writeFileSync(join(root, "a.ts"), "one\n");
	writeFileSync(join(root, "b.ts"), "one\n");
	const guarded = guard();
	await guarded.result(await read("a.ts"));
	await guarded.result(await read("b.ts"));
	rmSync(join(root, "a.ts"));
	store.recordWrite({
		path: join(root, "a.ts"),
		author: { kind: "user", clientKey: "c" },
		before: Buffer.from("one\n"),
		after: null,
	});
	rmSync(join(root, "b.ts"));

	const blocked = await guarded.call("write", "w1", { path: "a.ts", content: "x\n" });
	expect(blocked?.reason).toBe(
		"Blocked: a.ts was deleted since you read it (by the user 0 s ago). Read it to confirm, then write again.",
	);
	const outside = await guarded.call("write", "w2", { path: "b.ts", content: "x\n" });
	expect(outside?.reason).toContain(
		"b.ts was deleted since you read it (by a terminal command or a program outside",
	);

	const missing = await read("a.ts", "r2");
	expect(missing.isError).toBe(true);
	await guarded.result(missing);
	expect(await guarded.call("write", "w3", { path: "a.ts", content: "x\n" })).toBeUndefined();
	await guarded.result(await write("w3", "a.ts", "x\n"));
	expect(existsSync(join(root, "a.ts"))).toBe(true);
});

test("the write check hashes the file once", async () => {
	writeFileSync(join(root, "a.ts"), "one\n");
	const guarded = guard();
	await guarded.result(await read("a.ts"));
	const digest = spyOn(Hash.prototype, "digest");
	try {
		expect(await guarded.call("write", "w1", { path: "a.ts", content: "x\n" })).toBeUndefined();
		expect(digest).toHaveBeenCalledTimes(1);
	} finally {
		digest.mockRestore();
	}
});

test("a command typed in the terminal is named as one, not only as a program outside ThinkRail", async () => {
	writeFileSync(join(root, "a.ts"), "one\n");
	const guarded = guard();
	await guarded.result(await read("a.ts"));
	Bun.spawnSync(["sh", "-c", "echo x >> a.ts"], { cwd: root });
	const blocked = await guarded.call("write", "w1", { path: "a.ts", content: "two\n" });
	expect(blocked?.reason).toStartWith(
		"Blocked: a.ts changed since you read it (by a terminal command or a program outside ThinkRail).",
	);
	expect(blocked?.reason).toContain("+x");
});
