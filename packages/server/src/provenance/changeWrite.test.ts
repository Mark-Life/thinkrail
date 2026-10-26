import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
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
	const late: unknown[] = [];
	expect(provenance.changeWrite(path, (write) => late.push(write))).toBeUndefined();
	provenance.recordWrite({
		path,
		author: AGENT,
		before: null,
		after: bytes("agent\n"),
		toolCallId: "t1",
	});
	provenance.endTool({ sessionId: "s1", toolCallId: "t1" });
	await Promise.resolve();
	expect(late).toEqual([{ author: AGENT, hash: hashBytes(bytes("agent\n")) }]);
	expect(provenance.changeWrite(path)?.author).toEqual(AGENT);
});

test("a user save queued ahead of the agent's record still leaves the held version to the agent", async () => {
	const provenance = store();
	const path = put("race.ts", "a\n");
	provenance.recordRead({ sessionId: "s1", path, bytes: bytes("a\n") });
	provenance.openClaim({
		sessionId: "s1",
		toolCallId: "t1",
		path,
		mutates: true,
		hash: hashBytes(bytes("a\n")),
	});
	writeFileSync(path, "agent\n");
	const late: unknown[] = [];
	expect(provenance.changeWrite(path, (write) => late.push(write))).toBeUndefined();
	writeFileSync(path, "agent\nmine\n");
	provenance.recordWrite({ path, author: USER, before: null, after: bytes("agent\nmine\n") });
	provenance.recordWrite({
		path,
		author: AGENT,
		before: null,
		after: bytes("agent\nmine\n"),
		toolCallId: "t1",
	});
	await Promise.resolve();
	expect(late).toEqual([{ author: AGENT, hash: hashBytes(bytes("agent\n")) }]);
});

test("a held path the closing tool never recorded calls back nothing", async () => {
	const provenance = store();
	const path = put("same.ts", "a\n");
	const late: unknown[] = [];
	provenance.openClaim({ sessionId: "s1", toolCallId: "t2", path, mutates: true, hash: null });
	writeFileSync(path, "outside\n");
	provenance.changeWrite(path, (write) => late.push(write));
	provenance.endTool({ sessionId: "s1", toolCallId: "t2" });
	await Promise.resolve();
	expect(late).toEqual([]);
});

function heldOutsideWrite(provenance: ReturnType<typeof store>, path: string) {
	provenance.openClaim({
		sessionId: "s1",
		toolCallId: "t1",
		path,
		mutates: true,
		hash: hashBytes(bytes("a\n")),
	});
	writeFileSync(path, "a\nformatter\n");
	const late: unknown[] = [];
	expect(provenance.changeWrite(path, (write) => late.push(write))).toBeUndefined();
	writeFileSync(path, "a\nformatter\nagent\n");
	provenance.recordWrite({
		path,
		author: AGENT,
		before: bytes("a\nformatter\n"),
		after: bytes("a\nformatter\nagent\n"),
		toolCallId: "t1",
	});
	return late;
}

test("an outside write during an agent's claim on a tracked path is external, not the agent", async () => {
	const provenance = store();
	const path = put("formatted.ts", "a\n");
	provenance.recordWrite({ path, author: USER, before: null, after: bytes("a\n") });
	provenance.recordRead({ sessionId: "s1", path, bytes: bytes("a\n") });
	const late = heldOutsideWrite(provenance, path);
	await Promise.resolve();
	expect(late).toEqual([
		{ author: { kind: "external" }, hash: hashBytes(bytes("a\nformatter\n")) },
	]);
});

test("an outside write during an agent's claim on an untracked path names no one", async () => {
	const provenance = store();
	const path = put("untracked.ts", "a\n");
	provenance.recordRead({ sessionId: "s1", path, bytes: bytes("a\n") });
	const late = heldOutsideWrite(provenance, path);
	await Promise.resolve();
	expect(late).toEqual([]);
});

test("a file an agent script renames or deletes is credited to that script", () => {
	const provenance = store();
	const from = put("from.ts", "a\n");
	const to = join(dir, "to.ts");
	const old = new Date(clock - 60_000);
	utimesSync(from, old, old);
	const gone = put("gone.ts", "x\n");
	provenance.openBashWindow({ sessionId: "s1", toolCallId: "t1", cwd: dir });
	renameSync(from, to);
	unlinkSync(gone);
	const script = { kind: "agent", sessionId: "s1", via: "script" } as const;
	expect(provenance.changeWrite(to)).toEqual({ author: script, hash: hashBytes(bytes("a\n")) });
	expect(provenance.changeWrite(from)).toEqual({ author: script, hash: null });
	expect(provenance.changeWrite(gone)).toEqual({ author: script, hash: null });
});
