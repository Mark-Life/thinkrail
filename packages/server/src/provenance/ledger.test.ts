import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBytes } from "../fs";
import { createProvenance, recordingQueue, type WriteAuthor } from "./ledger";
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
		before: bytes("one\n"),
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
	provenance.recordWrite({ path, author: AGENT, before: null, after: bytes("three\n") });
	expect(provenance.lastWrite({ path, hash: hashBytes(bytes("three\n")), clientKey: "x" })).toEqual(
		{ author: AGENT, at: clock },
	);
});

test("an unknown version infers a script inside a bash window, then external, else nothing", () => {
	const provenance = store();
	const fresh = put("fresh.ts", "x\n");
	expect(provenance.lastWrite({ path: fresh, hash: "h", clientKey: "c" })).toBeUndefined();

	const tracked = put("tracked.ts", "a\n");
	provenance.recordWrite({ path: tracked, author: USER, before: null, after: bytes("a\n") });
	writeFileSync(tracked, "b\n");
	const mtime = new Date(clock - 60_000);
	utimesSync(tracked, mtime, mtime);
	expect(provenance.lastWrite({ path: tracked, hash: "other", clientKey: "c" })).toEqual({
		author: { kind: "external", inferred: true },
		at: mtime.getTime(),
	});

	clock = Date.now();
	provenance.openBashWindow({ sessionId: "s2", toolCallId: "t1" });
	writeFileSync(fresh, "by script\n");
	expect(provenance.lastWrite({ path: fresh, hash: "h", clientKey: "c" })?.author).toEqual({
		kind: "agent",
		sessionId: "s2",
		via: "script",
		inferred: true,
	});
});

test("a write since the session's read is stale and carries the cached baseline text", () => {
	const provenance = store();
	const path = put("a.ts", "one\ntwo\nthree\n");
	provenance.recordRead({ sessionId: "s1", path, bytes: snapshot(path).bytes });
	expect(provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) })).toBeNull();

	clock += 1000;
	const before = readFileSync(path);
	put("a.ts", "one\nTWO\nthree\n");
	provenance.recordWrite({ path, author: USER, before, after: snapshot(path).bytes });

	const stale = provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) });
	expect(stale).toMatchObject({
		baseline: { at: 1_000_000 },
		untracked: false,
		baselineText: "one\ntwo\nthree\n",
	});
	expect(stale?.writers.map((entry) => [entry.author.kind, entry.line])).toEqual([["user", 2]]);
	expect(provenance.staleRead({ sessionId: "s9", path, current: snapshot(path) })?.baseline).toBe(
		null,
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
	provenance.openBashWindow({ sessionId: "s1", toolCallId: "b1" });
	put("a.ts", "sed\n");
	const own = provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) });
	expect(own?.script).toEqual({ sessionId: "s1", self: true });
});

test("the agent's own write moves its baseline, so only other writers are reported", () => {
	const provenance = store();
	const path = put("a.ts", "one\n");
	provenance.recordRead({ sessionId: "s1", path, bytes: snapshot(path).bytes });
	put("a.ts", "two\n");
	provenance.recordWrite({ path, author: AGENT, before: bytes("one\n"), after: bytes("two\n") });
	expect(provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) })).toBeNull();
});

test("without a read, only other writers since the session's last write in the last 10 minutes count", () => {
	const provenance = store();
	const path = put("a.ts", "one\n");
	provenance.recordWrite({ path, author: USER, before: null, after: bytes("old\n") });
	clock += 11 * 60 * 1000;
	expect(provenance.staleRead({ sessionId: "s1", path, current: snapshot(path) })).toBeNull();
	provenance.recordWrite({ path, author: USER, before: null, after: bytes("recent\n") });
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

test("closing a bash window returns only the user writes that landed during it", () => {
	const provenance = store();
	const path = put("a.ts", "one\n");
	provenance.recordWrite({ path, author: USER, before: null, after: bytes("before\n") });
	provenance.openBashWindow({ sessionId: "s1", toolCallId: "b1" });
	provenance.recordWrite({ path, author: AGENT, before: null, after: bytes("agent\n") });
	provenance.recordWrite({ path, author: USER, before: bytes("x\n"), after: bytes("during\n") });
	const closed = provenance.closeBashWindow({ sessionId: "s1", toolCallId: "b1" });
	provenance.recordWrite({ path, author: USER, before: null, after: bytes("after\n") });
	expect(closed?.map((entry) => entry.hash)).toEqual([hashBytes(bytes("during\n"))]);
	expect(provenance.closeBashWindow({ sessionId: "s1", toolCallId: "b1" })).toBeNull();
});

test("a path keeps its 32 newest writes", () => {
	const provenance = store();
	const path = put("a.ts", "x\n");
	for (let index = 0; index < 40; index++) {
		provenance.recordWrite({ path, author: USER, before: null, after: bytes(`${index}\n`) });
	}
	const hashOf = (index: number) => hashBytes(bytes(`${index}\n`));
	expect(provenance.lastWrite({ path, hash: hashOf(39), clientKey: "c" })?.author.kind).toBe(
		"user",
	);
	expect(provenance.lastWrite({ path, hash: hashOf(0), clientKey: "c" })?.author.kind).toBe(
		"external",
	);
});

test("recordingQueue records a write the queued run made, and nothing for a no-op", async () => {
	const provenance = store();
	const path = put("a.ts", "one\n");
	const direct = <T>(_abs: string, run: () => Promise<T>) => run();
	const queue = recordingQueue(direct, USER, provenance);

	await queue(path, async () => undefined);
	expect(provenance.lastWrite({ path, hash: hashBytes(bytes("one\n")), clientKey: "c" })).toBe(
		undefined,
	);

	await queue(path, async () => writeFileSync(path, "two\n"));
	expect(
		provenance.lastWrite({ path, hash: hashBytes(bytes("two\n")), clientKey: "client-a" }),
	).toEqual({ author: { kind: "user", thisClient: true }, at: clock });
});
