import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	createEditTool,
	createReadTool,
	createWriteTool,
	type ToolCallEventResult,
	type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { hashBytes } from "../fs";
import { createProvenance, type Provenance } from "../provenance";
import { agentPath, fileGuardExtension, isStaleEditError } from "./fileGuard";

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
		shutdown: (reason: string) => emit("session_shutdown", { type: "session_shutdown", reason }),
	};
}

async function run(
	tool: PiTool,
	toolCallId: string,
	input: Record<string, unknown>,
): Promise<ToolOutcome> {
	const base = { toolName: tool.name, toolCallId, input };
	try {
		const result = await tool.execute(toolCallId, input as never);
		return { ...base, content: result.content, details: result.details, isError: false };
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		return { ...base, content: [{ type: "text", text }], details: undefined, isError: true };
	}
}

const read = (path: string) => run(createReadTool(root) as PiTool, `read-${path}`, { path });
const edit = (path: string, oldText: string, newText: string) =>
	run(createEditTool(root) as PiTool, `edit-${path}`, { path, edits: [{ oldText, newText }] });
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

test("agentPath resolves like pi's tools: @ prefix, ~ and relative paths", () => {
	expect(agentPath("@src/a.ts", root)).toBe(join(root, "src/a.ts"));
	expect(agentPath("~/x.ts", root)).toBe(join(homedir(), "x.ts"));
	expect(agentPath("/abs/x.ts", root)).toBe("/abs/x.ts");
	expect(agentPath("a b.ts", root)).toBe(join(root, "a b.ts"));
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
		"ThinkRail: a.ts was changed by You 0 s ago (line 1) since you last read it. Re-read the file before editing.",
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
		"Blocked: read.ts changed since this agent read it (by You 0 s ago). Re-read before writing.",
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
		"Blocked: a.ts changed since this agent read it (by another agent 0 s ago).",
	);
});

test("a change made by the session's own shell command does not block its write", async () => {
	writeFileSync(join(root, "a.ts"), "one\n");
	const guarded = guard();
	await guarded.result(await read("a.ts"));
	await guarded.call("bash", "b1", { command: "sed -i '' s/one/two/ a.ts" });
	writeFileSync(join(root, "a.ts"), "two\n");
	expect(await guarded.call("write", "w1", { path: "a.ts", content: "x\n" })).toBeUndefined();
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
		"Note: You edited a.ts 0 s ago during this call (line 2).",
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
