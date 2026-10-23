import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import { createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import type {
	ChangeReceipt,
	FileRead,
	FileWriteResult,
	WorkspaceFsChangedPayload,
} from "@thinkrail/contracts";
import { hashBytes } from "../fs";
import { setWatchPublisher, stopAllWatches } from "../watch";
import { handleRequest } from "./handlers";

const CTX = { clientKey: "test-client" };
const BYTES = new TextEncoder();
const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const PI = "@earendil-works/pi-coding-agent";

let dataDir: string;
let root: string;
const savedDataDir = process.env.THINKRAIL_DATA_DIR;

function hash(content: string): string {
	return hashBytes(BYTES.encode(content));
}

function save(path: string, content: string, expectHash: string | null) {
	return handleRequest(
		"fs.writeFile",
		{ workspaceId: "w1", path, content, expect: { hash: expectHash } },
		CTX,
	) as Promise<FileWriteResult>;
}

function lastActiveAt(): number | undefined {
	const rows = JSON.parse(readFileSync(join(dataDir, "workspaces.json"), "utf8")) as {
		lastActiveAt?: number;
	}[];
	return rows[0]?.lastActiveAt;
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "trpi-file-write-test-"));
	process.env.THINKRAIL_DATA_DIR = dataDir;
	root = join(dataDir, "worktree");
	mkdirSync(root);
	writeFileSync(
		join(dataDir, "workspaces.json"),
		JSON.stringify([{ id: "w1", projectId: "p1", name: "w1", worktreePath: root, createdAt: 1 }]),
	);
});

afterEach(() => {
	stopAllWatches();
	setWatchPublisher(null);
	rmSync(dataDir, { recursive: true, force: true });
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
});

interface Gate {
	entered: Promise<void>;
	enter: () => void;
	release: () => void;
	wait: Promise<void>;
}

function gate(): Gate {
	let enter = (): void => {};
	let release = (): void => {};
	const entered = new Promise<void>((resolveEnter) => {
		enter = resolveEnter;
	});
	const wait = new Promise<void>((resolveWait) => {
		release = resolveWait;
	});
	return { entered, enter, release, wait };
}

function gatedEdit(held: Gate) {
	return createEditTool(root, {
		operations: {
			access: async () => {},
			readFile: async (abs) => {
				held.enter();
				await held.wait;
				return readFileSync(abs);
			},
			writeFile: async (abs, content) => writeFileSync(abs, content),
		},
	});
}

async function expectHeld<T>(start: () => Promise<T>, held: Gate): Promise<T> {
	const realQueue = pi.withFileMutationQueue;
	const queued = gate();
	const spy = spyOn(pi, "withFileMutationQueue").mockImplementation((abs, run) => {
		queued.enter();
		return realQueue(abs, run);
	});
	let settled = false;
	const tracked = start().finally(() => {
		settled = true;
	});
	const done = tracked.then(
		() => {},
		() => {},
	);
	try {
		await Promise.race([queued.entered, done]);
	} finally {
		spy.mockRestore();
	}
	await Bun.sleep(50);
	expect(settled).toBe(false);
	held.release();
	return tracked;
}

function git(...args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", root, ...args], {
		stdout: "ignore",
		stderr: "ignore",
	});
	if (!result.success) throw new Error(`git ${args.join(" ")} failed`);
}

function commitRepo(path: string, content: string): void {
	git("init", "-b", "main");
	git("config", "user.email", "t@thinkrail.test");
	git("config", "user.name", "test");
	git("config", "commit.gpgsign", "false");
	writeFileSync(join(root, path), content);
	git("add", "-A");
	git("commit", "-m", "init");
}

function revert(path: string, originalHash: string, modifiedHash: string) {
	return handleRequest(
		"change.revert",
		{
			workspaceId: "w1",
			path,
			scope: { kind: "uncommitted" },
			target: { kind: "file" },
			expect: { originalHash, modifiedHash },
		},
		CTX,
	) as Promise<{ receipt: ChangeReceipt }>;
}

test("a save waits behind a pending pi edit of the same file, then answers stale", async () => {
	writeFileSync(join(root, "a.ts"), "const a = 1;\n");
	const held = gate();
	const editing = gatedEdit(held).execute("call-1", {
		path: "a.ts",
		edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
	});
	await held.entered;

	const saving = expectHeld(() => save("a.ts", "const a = 3;\n", hash("const a = 1;\n")), held);
	await editing;
	expect(await saving).toMatchObject({
		status: "stale",
		current: { content: "const a = 2;\n" },
	});
	expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("const a = 2;\n");
});

test("a save waits behind a pending pi write of the same file, then answers stale", async () => {
	writeFileSync(join(root, "a.ts"), "base\n");
	const held = gate();
	const write = createWriteTool(root, {
		operations: {
			mkdir: async () => {
				held.enter();
				await held.wait;
			},
			writeFile: async (abs, content) => writeFileSync(abs, content),
		},
	});
	const writing = write.execute("call-1", { path: "a.ts", content: "from pi\n" });
	await held.entered;

	const saving = expectHeld(() => save("a.ts", "mine\n", hash("base\n")), held);
	await writing;
	expect(await saving).toMatchObject({ status: "stale", current: { content: "from pi\n" } });
	expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("from pi\n");
});

test("change.revert waits behind a pending pi edit of the same file, then is stale", async () => {
	commitRepo("a.ts", "one\n");
	writeFileSync(join(root, "a.ts"), "two\n");
	const held = gate();
	const editing = gatedEdit(held).execute("call-1", {
		path: "a.ts",
		edits: [{ oldText: "two", newText: "three" }],
	});
	await held.entered;

	const reverting = expectHeld(() => revert("a.ts", hash("one\n"), hash("two\n")), held);
	await editing;
	await expect(reverting).rejects.toMatchObject({ code: "STALE_VIEW" });
	expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("three\n");
});

test("change.undo waits behind a pending pi edit of the same file, then is stale", async () => {
	commitRepo("a.ts", "one\n");
	writeFileSync(join(root, "a.ts"), "two\n");
	const { receipt } = await revert("a.ts", hash("one\n"), hash("two\n"));
	expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("one\n");
	const held = gate();
	const editing = gatedEdit(held).execute("call-1", {
		path: "a.ts",
		edits: [{ oldText: "one", newText: "pi" }],
	});
	await held.entered;

	const undoing = expectHeld(
		() =>
			handleRequest(
				"change.undo",
				{ workspaceId: "w1", receiptId: receipt.id, expect: { modifiedHash: hash("one\n") } },
				CTX,
			),
		held,
	);
	await editing;
	await expect(undoing).rejects.toMatchObject({ code: "STALE_VIEW" });
	expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("pi\n");
});

test("two concurrent saves from one base: the first writes, the second is stale", async () => {
	writeFileSync(join(root, "a.ts"), "base\n");
	const results = await Promise.all([
		save("a.ts", "left\n", hash("base\n")),
		save("a.ts", "right\n", hash("base\n")),
	]);
	expect(results.map((result) => result.status)).toEqual(["written", "stale"]);
	expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("left\n");
});

test("two concurrent saves of identical text both answer written", async () => {
	writeFileSync(join(root, "a.ts"), "base\n");
	const results = await Promise.all([
		save("a.ts", "same\n", hash("base\n")),
		save("a.ts", "same\n", hash("base\n")),
	]);
	expect(results).toEqual([
		{ status: "written", meta: { hash: hash("same\n"), byteLength: 5, text: true } },
		{ status: "written", meta: { hash: hash("same\n"), byteLength: 5, text: true } },
	]);
});

test("workspace activity is stamped only when a save changes bytes", async () => {
	writeFileSync(join(root, "a.ts"), "base\n");
	await save("a.ts", "base\n", hash("base\n"));
	expect(lastActiveAt()).toBeUndefined();
	await save("a.ts", "next\n", hash("base\n"));
	expect(lastActiveAt()).toBeNumber();
});

function readAs(clientKey: string, path: string) {
	return handleRequest(
		"fs.readFile",
		{ workspaceId: "w1", path },
		{ clientKey },
	) as Promise<FileRead>;
}

test("a save is recorded as the user, and readFile reports it to the saving client only as this client", async () => {
	writeFileSync(join(root, "a.ts"), "base\n");
	expect((await readAs(CTX.clientKey, "a.ts")).lastWrite).toBeUndefined();
	await save("a.ts", "mine\n", hash("base\n"));
	expect((await readAs(CTX.clientKey, "a.ts")).lastWrite).toEqual({
		author: { kind: "user", thisClient: true },
		at: expect.any(Number),
	});
	expect((await readAs("other-client", "a.ts")).lastWrite?.author).toEqual({
		kind: "user",
		thisClient: false,
	});
	writeFileSync(join(root, "a.ts"), "outside\n");
	expect((await readAs(CTX.clientKey, "a.ts")).lastWrite?.author).toEqual({
		kind: "external",
		inferred: true,
	});
});

test("a change.revert is recorded as the user's write", async () => {
	commitRepo("a.ts", "one\n");
	writeFileSync(join(root, "a.ts"), "two\n");
	await revert("a.ts", hash("one\n"), hash("two\n"));
	expect((await readAs(CTX.clientKey, "a.ts")).lastWrite?.author).toEqual({
		kind: "user",
		thisClient: true,
	});
});

test("a save's fsChanged frame names the target and never the temp file", async () => {
	const payloads: WorkspaceFsChangedPayload[] = [];
	setWatchPublisher((payload) => payloads.push(payload));
	writeFileSync(join(root, "a.ts"), "base\n");
	await handleRequest("workspace.watchReady", { workspaceId: "w1" }, CTX);
	payloads.length = 0;
	await save("a.ts", "next\n", hash("base\n"));
	const deadline = Date.now() + 3000;
	while (!payloads.some((payload) => payload.paths.includes("a.ts"))) {
		if (Date.now() > deadline) throw new Error("no fsChanged frame named a.ts");
		await Bun.sleep(25);
	}
	await Bun.sleep(400);
	expect(
		payloads.flatMap((payload) => payload.paths).filter((p) => p.includes(".thinkrail-")),
	).toEqual([]);
});

test("every package that depends on pi loads one pi copy, so they share one mutation queue", () => {
	const rootManifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
		workspaces: { packages: string[] };
	};
	const dependents = rootManifest.workspaces.packages
		.flatMap((pattern) => [...new Bun.Glob(`${pattern}/package.json`).scanSync(REPO_ROOT)])
		.map((manifest) => join(REPO_ROOT, manifest))
		.filter((manifest) => {
			const pkg = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
			return ["dependencies", "devDependencies", "peerDependencies"].some(
				(field) => PI in ((pkg[field] ?? {}) as Record<string, string>),
			);
		})
		.map((manifest) => dirname(manifest));
	expect(dependents).toContain(join(REPO_ROOT, "packages/server"));
	expect(dependents.length).toBeGreaterThan(2);
	const copies = new Set(dependents.map((dir) => realpathSync(Bun.resolveSync(PI, dir))));
	expect([...copies]).toHaveLength(1);
});
