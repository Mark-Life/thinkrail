import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testSessionId } from "@thinkrail/contracts/test-ids";
import { WORKSPACE_TODOS_DIR } from "@thinkrail/shared/paths";
import { observeLoggedErrors } from "../log";
import {
	markOtherSessionWindowsShared,
	otherSessionWindows,
	readBaselines,
	removeSessionBaselines,
	writeBaselines,
} from "./baselines";
import {
	clearAllPendingReviews,
	markReviewPending,
	readAutoCycles,
	readReviewMeta,
	readReviewRecords,
	removeSessionReviews,
} from "./reviews";

let root: string;
let dir: string;

const write = (name: string, value: unknown) =>
	writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
const copies = () => readdirSync(dir).filter((name) => name.includes(".corrupt-"));

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "todo-sidecars-"));
	dir = join(root, WORKSPACE_TODOS_DIR);
	mkdirSync(dir, { recursive: true });
});

let logged: unknown[] = [];

beforeEach(() => {
	logged = [];
	observeLoggedErrors((scope, error) => {
		if (scope === "todos") logged.push(error);
	});
});

afterEach(() => {
	observeLoggedErrors(null);
	rmSync(root, { recursive: true, force: true });
});

test("a baselines file from an older release loads whole", () => {
	write("s1.baselines.json", {
		version: 1,
		items: {
			noShared: { paths: ["a.ts"], head: "abc" },
			noHead: { paths: [], head: null, shared: true },
		},
	});
	expect(readBaselines(root, testSessionId("s1"))).toEqual({
		noShared: { paths: ["a.ts"], head: "abc" },
		noHead: { paths: [], head: null, shared: true },
	});
	expect(copies()).toEqual([]);
});

test("a reviews file from an older release loads whole", () => {
	write("s1.reviews.json", {
		version: 1,
		items: { t1: { state: "reviewed", reviewedShas: ["abc"], at: "2026-01-01T00:00:00.000Z" } },
		pending: { t2: { at: "2026-01-01T00:00:00.000Z" } },
		autoCycles: { t3: 2 },
	});
	expect(Object.keys(readReviewRecords(root, testSessionId("s1")))).toEqual(["t1"]);
	expect(readReviewMeta(root, testSessionId("s1")).pending.t2?.at).toBe("2026-01-01T00:00:00.000Z");
	expect(readAutoCycles(root, testSessionId("s1"), "t3")).toBe(2);
	expect(copies()).toEqual([]);
});

test("a bad baseline is dropped, the rest load, and its bytes survive the next save", () => {
	const raw = JSON.stringify({
		version: 1,
		items: { good: { paths: [], head: null }, bad: null, wrong: { paths: "a", head: null } },
	});
	write("s1.baselines.json", raw);
	const items = readBaselines(root, testSessionId("s1"));
	expect(Object.keys(items)).toEqual(["good"]);
	writeBaselines(root, testSessionId("s1"), items);
	const [copy] = copies();
	expect(copy).toBeDefined();
	expect(readFileSync(join(dir, `${copy}`), "utf8")).toBe(raw);
	expect(readBaselines(root, testSessionId("s1"))).toEqual(items);
});

test("each section of a reviews file drops its own bad entries", () => {
	write("s1.reviews.json", {
		version: 1,
		items: { bad: { state: "unknown", reviewedShas: [], at: "x" } },
		pending: { good: { at: "x" }, bad: { at: 1 } },
		autoCycles: { good: 1, bad: "1" },
	});
	expect(readReviewRecords(root, testSessionId("s1"))).toEqual({});
	expect(Object.keys(readReviewMeta(root, testSessionId("s1")).pending)).toEqual(["good"]);
	expect(readAutoCycles(root, testSessionId("s1"), "bad")).toBeUndefined();
	expect(readAutoCycles(root, testSessionId("s1"), "good")).toBe(1);
	expect(copies().length).toBeGreaterThan(0);
});

test("a sidecar that is not an object or not JSON loads empty and is kept", () => {
	write("s1.baselines.json", "null");
	write("s2.baselines.json", '{ "items": [] }');
	write("s3.reviews.json", "{ torn");
	expect(readBaselines(root, testSessionId("s1"))).toEqual({});
	expect(readBaselines(root, testSessionId("s2"))).toEqual({});
	expect(readReviewRecords(root, testSessionId("s3"))).toEqual({});
	expect(copies().length).toBe(3);
});

test("a sidecar that could not be read is not replaced", () => {
	mkdirSync(join(dir, "s1.baselines.json"));
	expect(readBaselines(root, testSessionId("s1"))).toEqual({});
	expect(() => writeBaselines(root, testSessionId("s1"), { t: { paths: [], head: null } })).toThrow(
		"could not be read",
	);
	mkdirSync(join(dir, "s2.reviews.json"));
	expect(() => markReviewPending(root, testSessionId("s2"), "t")).toThrow("could not be read");
	expect(existsSync(join(dir, "s1.baselines.json", "t"))).toBe(false);
});

test("a kept copy is never read back as a session", () => {
	write("s1.baselines.json", "{ torn");
	write("s2.reviews.json", "{ torn");
	readBaselines(root, testSessionId("s1"));
	readReviewRecords(root, testSessionId("s2"));
	expect(copies().length).toBe(2);
	rmSync(join(dir, "s1.baselines.json"));
	rmSync(join(dir, "s2.reviews.json"));
	expect(otherSessionWindows(root, testSessionId("s0"))).toBe(false);
	expect(clearAllPendingReviews(root)).toEqual([]);
	expect(readdirSync(dir).length).toBe(2);
});

test("a missing todo folder lists no chats and logs nothing", () => {
	rmSync(dir, { recursive: true });
	expect(otherSessionWindows(root, testSessionId("s1"))).toBe(false);
	expect(clearAllPendingReviews(root)).toEqual([]);
	expect(logged).toEqual([]);
});

test("a todo folder that cannot be listed is logged with a code", () => {
	rmSync(dir, { recursive: true });
	writeFileSync(dir, "not a folder");
	expect(otherSessionWindows(root, testSessionId("s1"))).toBe(false);
	expect(clearAllPendingReviews(root)).toEqual([]);
	expect(logged).toEqual([
		expect.objectContaining({ code: "STATE_FILE_UNREADABLE" }),
		expect.objectContaining({ code: "STATE_FILE_UNREADABLE" }),
	]);
});

test("a sidecar that cannot be removed or marked shared is logged with a code", () => {
	mkdirSync(join(dir, "s1.baselines.json", "held"), { recursive: true });
	mkdirSync(join(dir, "s1.reviews.json", "held"), { recursive: true });
	removeSessionBaselines(root, testSessionId("s1"));
	removeSessionReviews(root, testSessionId("s1"));
	write("s2.baselines.json", { version: 1, items: { t1: { paths: ["a.ts"], head: null } } });
	mkdirSync(join(dir, "s2.baselines.json.tmp"));
	markOtherSessionWindowsShared(root, testSessionId("s3"));
	expect(logged).toEqual([
		expect.objectContaining({ code: "STATE_FILE_WRITE_FAILED" }),
		expect.objectContaining({ code: "STATE_FILE_WRITE_FAILED" }),
		expect.objectContaining({ code: "STATE_FILE_WRITE_FAILED" }),
	]);
	expect(readBaselines(root, testSessionId("s2")).t1?.shared).toBeUndefined();
});
