import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBytes } from "../fs";
import { createProvenance, type WriteAuthor } from "./ledger";
import * as snapshot from "./snapshot";

const BYTES = new TextEncoder();
const USER: WriteAuthor = { kind: "user", clientKey: "client-a" };
const AGENT: WriteAuthor = { kind: "agent", sessionId: "s1", via: "tool", toolName: "edit" };

let dir: string;
let clock: number;

const store = () => createProvenance({ now: () => clock });
const bytes = (content: string) => BYTES.encode(content);

function put(name: string, content: string): string {
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "trpi-change-write-"));
	clock = Date.now();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

test("a recorded write names its author with the hash, and a user carries no client", () => {
	const provenance = store();
	const path = put("a.ts", "one\n");
	provenance.recordWrite({ path, author: USER, before: null, after: bytes("one\n") });
	expect(provenance.changeWrite(path)).toEqual({
		author: { kind: "user" },
		hash: hashBytes(bytes("one\n")),
	});

	writeFileSync(path, "two\n");
	provenance.recordWrite({ path, author: AGENT, before: bytes("one\n"), after: bytes("two\n") });
	expect(provenance.changeWrite(path)?.author).toEqual(AGENT);
});

test("a path with no history and no bash window has no author", () => {
	const provenance = store();
	expect(provenance.changeWrite(put("fresh.ts", "x\n"))).toBeUndefined();
});

test("a change to a tracked path infers external, and one inside a bash window the agent's script", () => {
	const provenance = store();
	const tracked = put("tracked.ts", "a\n");
	provenance.recordWrite({ path: tracked, author: USER, before: null, after: bytes("a\n") });
	writeFileSync(tracked, "b\n");
	expect(provenance.changeWrite(tracked)).toMatchObject({
		author: { kind: "external" },
		hash: hashBytes(bytes("b\n")),
	});

	provenance.openBashWindow({ sessionId: "s2", toolCallId: "t1", cwd: dir });
	const scripted = put("scripted.ts", "by script\n");
	expect(provenance.changeWrite(scripted)?.author).toEqual({
		kind: "agent",
		sessionId: "s2",
		via: "script",
	});
});

test("an old version is not a fresh change", () => {
	const provenance = store();
	const path = put("old.ts", "a\n");
	provenance.recordWrite({ path, author: AGENT, before: null, after: bytes("a\n") });
	clock += 60_000;
	expect(provenance.changeWrite(path)).toBeUndefined();

	writeFileSync(path, "b\n");
	const mtime = new Date(clock - 60_000);
	utimesSync(path, mtime, mtime);
	expect(provenance.changeWrite(path)).toBeUndefined();
});

test("an open edit claim on the path hides the author until the agent's write is recorded", () => {
	const provenance = store();
	const path = put("claimed.ts", "a\n");
	provenance.recordWrite({ path, author: USER, before: null, after: bytes("a\n") });
	provenance.openClaim({
		sessionId: "s1",
		toolCallId: "t1",
		path,
		mutates: true,
		hash: hashBytes(bytes("a\n")),
	});
	writeFileSync(path, "agent\n");
	expect(provenance.changeWrite(path)).toBeUndefined();

	provenance.recordWrite({
		path,
		author: AGENT,
		before: bytes("a\n"),
		after: bytes("agent\n"),
		toolCallId: "t1",
	});
	provenance.endTool({ sessionId: "s1", toolCallId: "t1" });
	expect(provenance.changeWrite(path)?.author).toEqual(AGENT);
});

test("a recorded delete names its author with a null hash", () => {
	const provenance = store();
	const path = put("gone.ts", "a\n");
	provenance.recordWrite({ path, author: USER, before: null, after: bytes("a\n") });
	unlinkSync(path);
	provenance.recordWrite({ path, author: AGENT, before: bytes("a\n"), after: null });
	expect(provenance.changeWrite(path)).toEqual({ author: AGENT, hash: null });
});

test("a stale tracked path and a path under a long-closed bash window cost no reads", () => {
	const provenance = store();
	const tracked = put("tracked.ts", "a\n");
	provenance.recordWrite({ path: tracked, author: AGENT, before: null, after: bytes("a\n") });
	provenance.openBashWindow({ sessionId: "s2", toolCallId: "t1", cwd: dir });
	provenance.endTool({ sessionId: "s2", toolCallId: "t1" });
	const built = put("built.js", "out\n");
	clock += 60 * 60_000;
	const reads = spyOn(snapshot, "readSnapshot");
	try {
		expect(provenance.changeWrite(built)).toBeUndefined();
		expect(provenance.changeWrite(tracked)).toBeUndefined();
		expect(reads).not.toHaveBeenCalled();
	} finally {
		reads.mockRestore();
	}
});

test("a path held back by an open claim calls back once the claim closes", async () => {
	const provenance = store();
	const path = put("late.ts", "a\n");
	provenance.openClaim({ sessionId: "s1", toolCallId: "t1", path, mutates: true, hash: null });
	writeFileSync(path, "agent\n");
	let late = 0;
	expect(provenance.changeWrite(path, () => late++)).toBeUndefined();
	provenance.recordWrite({
		path,
		author: AGENT,
		before: null,
		after: bytes("agent\n"),
		toolCallId: "t1",
	});
	provenance.endTool({ sessionId: "s1", toolCallId: "t1" });
	await Promise.resolve();
	expect(late).toBe(1);
	expect(provenance.changeWrite(path)?.author).toEqual(AGENT);
});
