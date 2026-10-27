import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBytes } from "../fs";
import { createProvenance, type WriteAuthor } from "./ledger";
import { readSnapshot } from "./snapshot";

const BYTES = new TextEncoder();
const USER: WriteAuthor = { kind: "user", clientKey: "client-a" };
const AGENT: WriteAuthor = { kind: "agent", sessionId: "s1", via: "tool", toolName: "edit" };

let dir: string;
let clock: number;

function store() {
	return createProvenance({ now: () => clock });
}

function put(name: string, content: string): string {
	const path = join(dir, name);
	writeFileSync(path, content);
	return path;
}

function bytes(content: string): Uint8Array {
	return BYTES.encode(content);
}

function snapshot(path: string) {
	const current = readSnapshot(path);
	if (!current) throw new Error(`no snapshot for ${path}`);
	return current;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "trpi-provenance-"));
	clock = 1_000_000;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

test("lastWrite names the recorded author of that exact version and hides the client key", () => {
	const provenance = store();
	const path = put("a.ts", "one\ntwo\n");
	provenance.recordWrite({
		path,
		author: USER,
		after: bytes("one\ntwo\n"),
	});

	const hash = hashBytes(bytes("one\ntwo\n"));
	expect(provenance.lastWrite({ path, hash, clientKey: "client-a" })).toEqual({
		author: { kind: "user", thisClient: true },
		at: clock,
	});
	expect(provenance.lastWrite({ path, hash, clientKey: "client-b" })?.author).toEqual({
		kind: "user",
		thisClient: false,
	});

	clock += 5;
	provenance.recordWrite({ path, author: AGENT, after: bytes("three\n") });
	expect(provenance.lastWrite({ path, hash: hashBytes(bytes("three\n")), clientKey: "x" })).toEqual(
		{ author: AGENT, at: clock },
	);
});

test("an unknown version infers a script inside a bash window, then external, else nothing", () => {
	const provenance = store();
	const fresh = put("fresh.ts", "x\n");
	expect(provenance.lastWrite({ path: fresh, hash: "h", clientKey: "c" })).toBeUndefined();

	const tracked = put("tracked.ts", "a\n");
	provenance.recordWrite({ path: tracked, author: USER, after: bytes("a\n") });
	writeFileSync(tracked, "b\n");
	const mtime = new Date(clock - 60_000);
	utimesSync(tracked, mtime, mtime);
	expect(provenance.lastWrite({ path: tracked, hash: "other", clientKey: "c" })).toEqual({
		author: { kind: "external" },
		at: mtime.getTime(),
	});

	clock = Date.now();
	provenance.openBashWindow({ sessionId: "s2", toolCallId: "t1", cwd: dir });
	writeFileSync(fresh, "by script\n");
	expect(provenance.lastWrite({ path: fresh, hash: "h", clientKey: "c" })?.author).toEqual({
		kind: "agent",
		sessionId: "s2",
		via: "script",
	});
});

test("a write since the session's read is stale and carries the cached baseline text", () => {
	const provenance = store();
	const path = put("a.ts", "one\ntwo\nthree\n");
	provenance.recordRead({ sessionId: "s1", path, bytes: snapshot(path).bytes });
	expect(provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) })).toBeNull();

	clock += 1000;
	put("a.ts", "one\nTWO\nthree\n");
	provenance.recordWrite({ path, author: USER, after: snapshot(path).bytes });

	const stale = provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) });
	expect(stale).toMatchObject({
		read: true,
		untracked: false,
		baselineText: "one\ntwo\nthree\n",
	});
	expect(stale?.writers.map((entry) => entry.author.kind)).toEqual(["user"]);
	expect(provenance.staleRead({ sessionId: "s9", path, current: snapshot(path) })?.read).toBe(
		false,
	);
});

test("an untracked change is stale, and one made during the session's own bash is marked self", () => {
	const provenance = store();
	const path = put("a.ts", "one\n");
	provenance.recordRead({ sessionId: "s1", path, bytes: snapshot(path).bytes });
	put("a.ts", "outside\n");
	const outside = provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) });
	expect(outside).toMatchObject({ untracked: true, writers: [] });
	expect(outside?.script).toBeUndefined();

	clock = Date.now();
	provenance.openBashWindow({ sessionId: "s1", toolCallId: "b1", cwd: dir });
	put("a.ts", "sed\n");
	const own = provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) });
	expect(own?.script).toEqual({ self: true });
});

test("the agent's own write moves its baseline, so only other writers are reported", () => {
	const provenance = store();
	const path = put("a.ts", "one\n");
	provenance.recordRead({ sessionId: "s1", path, bytes: snapshot(path).bytes });
	put("a.ts", "two\n");
	provenance.recordWrite({ path, author: AGENT, after: bytes("two\n") });
	expect(provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) })).toBeNull();
});

test("without a read, only other writers since the session's last write in the last 10 minutes count", () => {
	const provenance = store();
	const path = put("a.ts", "one\n");
	provenance.recordWrite({ path, author: USER, after: bytes("old\n") });
	clock += 11 * 60 * 1000;
	expect(provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) })).toBeNull();
	provenance.recordWrite({ path, author: USER, after: bytes("recent\n") });
	const stale = provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) });
	expect(stale?.writers).toHaveLength(1);
	expect(stale?.baselineText).toBeUndefined();
});

test("forgetSession drops the session's baselines", () => {
	const provenance = store();
	const path = put("a.ts", "one\n");
	provenance.recordRead({ sessionId: "s1", path, bytes: snapshot(path).bytes });
	put("a.ts", "two\n");
	provenance.forgetSession("s1");
	expect(provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) })).toBeNull();
});

test("the window cap drops closed windows first, so a long call keeps its window", () => {
	const provenance = store();
	const path = put("a.ts", "one\n");
	clock = Date.now();
	provenance.openBashWindow({ sessionId: "s1", toolCallId: "long", cwd: dir });
	for (let index = 0; index < 300; index++) {
		provenance.openBashWindow({ sessionId: "s2", toolCallId: `t${index}`, cwd: dir });
		provenance.closeBashWindow({ sessionId: "s2", toolCallId: `t${index}` });
	}
	clock += 60_000;
	put("a.ts", "two\n");
	utimesSync(path, new Date(clock), new Date(clock));
	expect(provenance.lastWrite({ path, hash: "other", clientKey: "c" })?.author).toEqual({
		kind: "agent",
		sessionId: "s1",
		via: "script",
	});
});

test("a path keeps its 32 newest writes", () => {
	const provenance = store();
	const path = put("a.ts", "x\n");
	for (let index = 0; index < 40; index++) {
		provenance.recordWrite({ path, author: USER, after: bytes(`${index}\n`) });
	}
	const hashOf = (index: number) => hashBytes(bytes(`${index}\n`));
	expect(provenance.lastWrite({ path, hash: hashOf(39), clientKey: "c" })?.author.kind).toBe(
		"user",
	);
	expect(provenance.lastWrite({ path, hash: hashOf(0), clientKey: "c" })?.author.kind).toBe(
		"external",
	);
});

test("a user delete is recorded, so the agent is told the user removed the file", () => {
	const provenance = store();
	const path = put("a.ts", "one\n");
	provenance.recordRead({ sessionId: "s1", path, bytes: snapshot(path).bytes });
	provenance.openBashWindow({ sessionId: "s1", toolCallId: "b1", cwd: dir });
	rmSync(path);
	provenance.recordWrite({ path, author: USER, after: null });
	expect(provenance.staleRead({ sessionId: "s1", path, current: null })).toMatchObject({
		writers: [{ author: USER, hash: null }],
		untracked: false,
	});
});

test("an ended tool closes its bash window, so later outside writes are not the agent's script", () => {
	const provenance = store();
	const path = put("a.ts", "one\n");
	provenance.recordWrite({ path, author: USER, after: bytes("one\n") });
	clock = Date.now();
	provenance.openBashWindow({ sessionId: "s1", toolCallId: "b1", cwd: dir });
	provenance.endTool({ sessionId: "s1", toolCallId: "b1" });
	clock += 60 * 60 * 1000;
	writeFileSync(path, "outside\n");
	utimesSync(path, new Date(clock), new Date(clock));
	expect(provenance.lastWrite({ path, hash: "other", clientKey: "c" })?.author).toEqual({
		kind: "external",
	});
});

test("a bash window covers only its own workspace", () => {
	const provenance = store();
	const elsewhere = mkdtempSync(join(tmpdir(), "trpi-provenance-other-"));
	try {
		const path = join(elsewhere, "b.ts");
		writeFileSync(path, "one\n");
		clock = Date.now();
		provenance.openBashWindow({ sessionId: "s1", toolCallId: "b1", cwd: dir });
		provenance.recordWrite({ path, author: USER, after: bytes("one\n") });
		writeFileSync(path, "outside\n");
		expect(provenance.lastWrite({ path, hash: "other", clientKey: "c" })?.author.kind).toBe(
			"external",
		);
	} finally {
		rmSync(elsewhere, { recursive: true, force: true });
	}
});

test("another session's write that lands between a tool call and its record contests the baseline", () => {
	const provenance = store();
	const path = put("a.ts", "one\n");
	const call = (sessionId: string, toolCallId: string, mutates: boolean) =>
		provenance.openClaim({ sessionId, toolCallId, path, mutates, hash: snapshot(path).hash });
	const agent = (sessionId: string) => ({ ...AGENT, sessionId });

	call("s1", "e1", true);
	call("s2", "e2", true);
	put("a.ts", "two\n");
	provenance.recordWrite({
		path,
		author: agent("s1"),
		after: bytes("two\n"),
		toolCallId: "e1",
	});
	expect(
		provenance.lastWrite({ path, hash: hashBytes(bytes("two\n")), clientKey: "c" })?.author,
	).toEqual(agent("s1"));
	provenance.recordWrite({
		path,
		author: agent("s2"),
		after: bytes("two\n"),
		toolCallId: "e2",
	});
	expect(
		provenance.lastWrite({ path, hash: hashBytes(bytes("two\n")), clientKey: "c" })?.author,
	).toEqual(agent("s2"));
	const stale = provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) });
	expect(stale?.writers.map((entry) => entry.author)).toEqual([agent("s2")]);
	expect(provenance.staleRead({ sessionId: "s2", path, current: snapshot(path) })).toBeNull();

	call("s1", "r1", false);
	put("a.ts", "saved\n");
	provenance.recordWrite({ path, author: USER, after: bytes("saved\n") });
	provenance.recordRead({ sessionId: "s1", toolCallId: "r1", path, bytes: snapshot(path).bytes });
	const afterRead = provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) });
	expect(afterRead?.writers.map((entry) => entry.author)).toEqual([USER]);

	call("s1", "r2", false);
	provenance.recordRead({ sessionId: "s1", toolCallId: "r2", path, bytes: snapshot(path).bytes });
	expect(provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) })).toBeNull();
});

test("a write made while another session's claim is open stays recorded as that agent's", () => {
	const provenance = store();
	const path = put("a.ts", "one\n");
	const s = { ...AGENT, sessionId: "s" };
	for (const sessionId of ["s", "t"]) {
		provenance.recordRead({ sessionId, path, bytes: snapshot(path).bytes });
	}
	provenance.openClaim({ sessionId: "t", toolCallId: "e", path, mutates: true, hash: null });
	provenance.openClaim({ sessionId: "s", toolCallId: "w", path, mutates: true, hash: null });
	put("a.ts", "s wrote\n");
	provenance.recordWrite({
		path,
		author: s,
		after: bytes("s wrote\n"),
		toolCallId: "w",
	});
	provenance.endTool({ sessionId: "s", toolCallId: "w" });
	const stale = provenance.staleRead({ sessionId: "t", path, current: snapshot(path) });
	expect(stale).toMatchObject({ writers: [{ author: s }], untracked: false });
	provenance.endTool({ sessionId: "t", toolCallId: "e" });
	const hash = hashBytes(bytes("s wrote\n"));
	expect(provenance.lastWrite({ path, hash, clientKey: "c" })?.author).toEqual(s);
});

test("a change inside overlapping bash windows is self only when no other session's window covers it", () => {
	const provenance = store();
	const path = put("a.ts", "one\n");
	clock = Date.now();
	provenance.recordRead({ sessionId: "s", path, bytes: snapshot(path).bytes });
	provenance.openBashWindow({ sessionId: "t", toolCallId: "bt", cwd: dir });
	provenance.openBashWindow({ sessionId: "s", toolCallId: "bs", cwd: dir });
	put("a.ts", "two\n");
	expect(provenance.staleRead({ sessionId: "s", path, current: snapshot(path) })?.script).toEqual({
		self: false,
	});
	provenance.closeBashWindow({ sessionId: "t", toolCallId: "bt" });
	clock += 60_000;
	put("a.ts", "three\n");
	utimesSync(path, new Date(clock), new Date(clock));
	expect(provenance.staleRead({ sessionId: "s", path, current: snapshot(path) })?.script).toEqual({
		self: true,
	});
});

test("an older version restored by a script is not credited to its first author", () => {
	const provenance = store();
	const path = put("a.ts", "A\n");
	clock = Date.now();
	provenance.recordWrite({ path, author: USER, after: bytes("A\n") });
	clock += 60_000;
	provenance.recordWrite({ path, author: AGENT, after: bytes("B\n") });
	clock += 60_000;
	provenance.openBashWindow({ sessionId: "s1", toolCallId: "b1", cwd: dir });
	put("a.ts", "A\n");
	utimesSync(path, new Date(clock + 1000), new Date(clock + 1000));
	expect(provenance.lastWrite({ path, hash: hashBytes(bytes("A\n")), clientKey: "c" })).toEqual({
		author: { kind: "agent", sessionId: "s1", via: "script" },
		at: clock + 1000,
	});
});

test("a read that found the file absent is a baseline, so only a later creation is stale", () => {
	const provenance = store();
	const path = join(dir, "gone.ts");
	provenance.recordRead({ sessionId: "s1", path, bytes: null });
	expect(provenance.staleRead({ sessionId: "s1", path, current: null })).toBeNull();
	put("gone.ts", "back\n");
	expect(provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) })).toMatchObject({
		read: true,
		untracked: true,
	});
});

test("a hash the caller already has is used as is, so the ledger does not hash those bytes again", () => {
	const provenance = store();
	const path = put("a.ts", "one\n");
	provenance.recordRead({ sessionId: "s1", path, bytes: bytes("one\n"), hash: "read-hash" });
	expect(
		provenance.staleRead({
			sessionId: "s1",
			path,
			current: { ...snapshot(path), hash: "read-hash" },
		}),
	).toBeNull();
	provenance.recordWrite({
		path,
		author: USER,
		after: bytes("two\n"),
		hash: "given",
	});
	expect(provenance.lastWrite({ path, hash: "given", clientKey: "client-a" })?.author).toEqual({
		kind: "user",
		thisClient: true,
	});
});

function agentEdit(provenance: ReturnType<typeof store>, path: string, content: string) {
	provenance.openClaim({
		sessionId: "s1",
		toolCallId: "e1",
		path,
		mutates: true,
		hash: snapshot(path).hash,
	});
	put("a.ts", content);
	provenance.recordWrite({
		path,
		author: AGENT,
		after: snapshot(path).bytes,
		toolCallId: "e1",
	});
}

test("an edit that starts from a save the agent never read keeps that save reported", () => {
	const provenance = store();
	const path = put("a.ts", "a = 1\nb = 2\n");
	provenance.recordRead({ sessionId: "s1", path, bytes: snapshot(path).bytes });
	put("a.ts", "a = 1\nb = 999\n");
	provenance.recordWrite({ path, author: USER, after: snapshot(path).bytes });
	agentEdit(provenance, path, "a = 10\nb = 999\n");

	const stale = provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) });
	expect(stale).toMatchObject({ read: true, untracked: false, baselineText: "a = 1\nb = 2\n" });
	expect(stale?.writers.map((entry) => entry.author.kind)).toEqual(["user"]);
});

test("an edit that starts from an outside change keeps it reported as untracked", () => {
	const provenance = store();
	const path = put("a.ts", "a = 1\nb = 2\n");
	provenance.recordRead({ sessionId: "s1", path, bytes: snapshot(path).bytes });
	put("a.ts", "a = 1\nb = 999\n");
	agentEdit(provenance, path, "a = 10\nb = 999\n");
	agentEdit(provenance, path, "a = 11\nb = 999\n");
	expect(provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) })).toMatchObject({
		read: true,
		writers: [],
		untracked: true,
	});

	provenance.recordRead({ sessionId: "s1", path, bytes: snapshot(path).bytes });
	agentEdit(provenance, path, "a = 12\nb = 999\n");
	expect(provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) })).toBeNull();
});

test("a delete during the session's own bash call is put down to that call", () => {
	const provenance = store();
	clock = Date.now();
	const path = put("a.ts", "one\n");
	provenance.recordRead({ sessionId: "s1", path, bytes: snapshot(path).bytes });
	provenance.openBashWindow({ sessionId: "s1", toolCallId: "b1", cwd: dir });
	rmSync(path);
	provenance.closeBashWindow({ sessionId: "s1", toolCallId: "b1" });
	expect(provenance.staleRead({ sessionId: "s1", path, current: null })).toMatchObject({
		untracked: true,
		script: { self: true },
	});
});

test("a move that keeps an old mtime during the session's own bash call is put down to that call", () => {
	const provenance = store();
	clock = Date.now();
	const path = put("a.ts", "one\n");
	provenance.recordWrite({ path, author: USER, after: bytes("one\n") });
	provenance.recordRead({ sessionId: "s1", path, bytes: snapshot(path).bytes });
	const backup = put("a.ts.bak", "backup\n");
	const old = new Date(clock - 60 * 60 * 1000);
	utimesSync(backup, old, old);
	provenance.openBashWindow({ sessionId: "s1", toolCallId: "b1", cwd: dir });
	renameSync(backup, path);
	provenance.closeBashWindow({ sessionId: "s1", toolCallId: "b1" });

	expect(provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) })?.script).toEqual({
		self: true,
	});
	expect(
		provenance.lastWrite({ path, hash: snapshot(path).hash, clientKey: "c" })?.author,
	).toMatchObject({ kind: "agent", sessionId: "s1", via: "script" });
});
