import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEditTool } from "@earendil-works/pi-coding-agent";
import type { FileWriteResult, WorkspaceFsChangedPayload } from "@thinkrail/contracts";
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

test("a save waits behind a pending pi edit of the same file, then answers stale", async () => {
	writeFileSync(join(root, "a.ts"), "const a = 1;\n");
	let enterRead = (): void => {};
	const reading = new Promise<void>((resolveRead) => {
		enterRead = resolveRead;
	});
	let releaseRead = (): void => {};
	const gate = new Promise<void>((resolveGate) => {
		releaseRead = resolveGate;
	});
	const edit = createEditTool(root, {
		operations: {
			access: async () => {},
			readFile: async (abs) => {
				enterRead();
				await gate;
				return readFileSync(abs);
			},
			writeFile: async (abs, content) => writeFileSync(abs, content),
		},
	});
	const editing = edit.execute("call-1", {
		path: "a.ts",
		edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
	});
	await reading;

	let settled = false;
	const saving = save("a.ts", "const a = 3;\n", hash("const a = 1;\n")).then((result) => {
		settled = true;
		return result;
	});
	await Bun.sleep(50);
	expect(settled).toBe(false);

	releaseRead();
	await editing;
	expect(await saving).toMatchObject({
		status: "stale",
		current: { content: "const a = 2;\n" },
	});
	expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("const a = 2;\n");
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

test("the host and pi-delegation load one pi copy, so they share one mutation queue", () => {
	const fromServer = Bun.resolveSync(PI, join(REPO_ROOT, "packages/server"));
	const fromDelegation = Bun.resolveSync(PI, join(REPO_ROOT, "packages/pi-delegation"));
	expect(realpathSync(fromDelegation)).toBe(realpathSync(fromServer));
});
