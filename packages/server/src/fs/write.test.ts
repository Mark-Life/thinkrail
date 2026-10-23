import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
import {
	chmodSync,
	chownSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_WRITE_MAX_BYTES, toEditorText } from "@thinkrail/contracts";
import { decodeText, hashBytes } from "./content";
import { writeTextFile } from "./write";

const BYTES = new TextEncoder();
const POSIX = process.platform !== "win32";
const ROOT_USER = process.getuid?.() === 0;
const LFS_POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 12\n`;

let dataDir: string;
let root: string;
const savedDataDir = process.env.THINKRAIL_DATA_DIR;

function hash(content: string | Uint8Array): string {
	return hashBytes(typeof content === "string" ? BYTES.encode(content) : content);
}

function put(path: string, content: string | Uint8Array): string {
	const abs = join(root, path);
	writeFileSync(abs, content);
	return abs;
}

function text(path: string): string {
	return readFileSync(join(root, path), "utf8");
}

function save(path: string, content: string, expectHash: string | null) {
	return writeTextFile({ workspaceId: "w1", path, content, expect: { hash: expectHash } });
}

function leftovers(dir = root): string[] {
	return readdirSync(dir).filter((name) => name.startsWith(".thinkrail-"));
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "trpi-fs-write-test-"));
	process.env.THINKRAIL_DATA_DIR = dataDir;
	root = join(dataDir, "worktree");
	mkdirSync(join(root, ".git"), { recursive: true });
	writeFileSync(
		join(dataDir, "workspaces.json"),
		JSON.stringify([{ id: "w1", projectId: "p1", name: "w1", worktreePath: root, createdAt: 1 }]),
	);
});

afterEach(() => {
	if (POSIX) chmodSync(root, 0o755);
	rmSync(dataDir, { recursive: true, force: true });
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
});

test("a save writes the content, answers the new hash and leaves no temp file", () => {
	put("a.ts", "one\n");
	const outcome = save("a.ts", "two\n", hash("one\n"));
	expect(outcome).toEqual({
		result: {
			status: "written",
			meta: { hash: hash("two\n"), byteLength: 4, text: true },
		},
		changed: true,
	});
	expect(text("a.ts")).toBe("two\n");
	expect(leftovers()).toEqual([]);
});

test("content that already matches the disk answers written without touching the file", () => {
	const abs = put("a.ts", "one\r\n");
	const before = statSync(abs);
	const outcome = save("a.ts", "one\n", "an-older-hash");
	expect(outcome).toEqual({
		result: { status: "written", meta: { hash: hash("one\r\n"), byteLength: 5, text: true } },
		changed: false,
	});
	const after = statSync(abs);
	expect(after.ino).toBe(before.ino);
	expect(after.mtimeMs).toBe(before.mtimeMs);
});

test("a replayed save succeeds with the hash the first one produced", () => {
	put("a.ts", "one\n");
	const params = {
		workspaceId: "w1",
		path: "a.ts",
		content: "two\n",
		expect: { hash: hash("one\n") },
	};
	expect(writeTextFile(params).result).toMatchObject({ status: "written" });
	expect(writeTextFile(params)).toEqual({
		result: { status: "written", meta: { hash: hash("two\n"), byteLength: 4, text: true } },
		changed: false,
	});
});

test("a stale hash answers the current content and meta, and writes nothing", () => {
	put("a.ts", "agent\n");
	expect(save("a.ts", "mine\n", hash("one\n")).result).toEqual({
		status: "stale",
		current: { content: "agent\n", meta: { hash: hash("agent\n"), byteLength: 6, text: true } },
	});
	expect(text("a.ts")).toBe("agent\n");
});

test("a missing file is missing unless the save is create-only", () => {
	expect(save("gone.ts", "x\n", hash("x"))).toEqual({
		result: { status: "missing" },
		changed: false,
	});
	expect(existsSync(join(root, "gone.ts"))).toBe(false);

	expect(save("new/dir/file.ts", "\uFEFFx\r\n", null).result).toMatchObject({ status: "written" });
	expect(readFileSync(join(root, "new/dir/file.ts"), "utf8")).toBe("\uFEFFx\r\n");
	expect(save("new/dir/file.ts", "y\n", null).result).toMatchObject({ status: "stale" });
	expect(readFileSync(join(root, "new/dir/file.ts"), "utf8")).toBe("\uFEFFx\r\n");
});

test("the disk file's line endings and BOM survive a save", () => {
	put("crlf.txt", "\uFEFFa\r\nb\r\n");
	save("crlf.txt", "a\nb\nc\n", hash("\uFEFFa\r\nb\r\n"));
	expect(text("crlf.txt")).toBe("\uFEFFa\r\nb\r\nc\r\n");
});

test("an unchanged save of a file that starts with two BOMs is a no-op", () => {
	const disk = Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61, 0x0a]);
	put("two-bom.ts", disk);
	const editorText = toEditorText(decodeText(disk));
	expect(editorText).toBe("\uFEFFa\n");
	expect(save("two-bom.ts", editorText, hash(disk))).toEqual({
		result: { status: "written", meta: { hash: hash(disk), byteLength: 8, text: true } },
		changed: false,
	});
	expect(readFileSync(join(root, "two-bom.ts"))).toEqual(disk);
});

test("a U+FEFF that starts the content of a BOM-less file is written, not dropped", () => {
	put("plain.ts", "x\n");
	const outcome = save("plain.ts", "\uFEFFx\n", hash("x\n"));
	const disk = Buffer.from([0xef, 0xbb, 0xbf, 0x78, 0x0a]);
	expect(outcome).toEqual({
		result: { status: "written", meta: { hash: hash(disk), byteLength: 5, text: true } },
		changed: true,
	});
	expect(readFileSync(join(root, "plain.ts"))).toEqual(disk);
});

test("a create below a regular file is not editable", () => {
	put("f", "file\n");
	expect(() => save("f/new.txt", "x", null)).toThrow(
		expect.objectContaining({ code: "NOT_EDITABLE" }),
	);
	expect(() => save("f/sub/new.txt", "x", null)).toThrow(
		expect.objectContaining({ code: "NOT_EDITABLE" }),
	);
	expect(text("f")).toBe("file\n");
});

test("a create that fails partway removes its file, so a replay creates again", () => {
	const realWrite = nodeFs.writeFileSync;
	const spy = spyOn(nodeFs, "writeFileSync").mockImplementation((file, data, options) => {
		if (typeof file !== "number") return realWrite(file, data, options);
		realWrite(file, "par");
		throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
	});
	try {
		expect(() => save("new.txt", "whole\n", null)).toThrow(
			expect.objectContaining({ code: "ENOSPC" }),
		);
	} finally {
		spy.mockRestore();
	}
	expect(existsSync(join(root, "new.txt"))).toBe(false);
	expect(save("new.txt", "whole\n", null).result).toMatchObject({ status: "written" });
	expect(text("new.txt")).toBe("whole\n");
});

test.skipIf(!POSIX)("a save reads the file once, even when it is written in place", () => {
	const abs = put("a.ts", "one\n");
	linkSync(abs, join(root, "b.ts"));
	const target = nodeFs.realpathSync(abs);
	const reads = spyOn(nodeFs, "readFileSync");
	const lstats = spyOn(nodeFs, "lstatSync");
	try {
		expect(save("a.ts", "two\n", hash("one\n")).result).toMatchObject({ status: "written" });
		expect(reads.mock.calls.filter(([path]) => path === target)).toHaveLength(1);
		expect(lstats.mock.calls.filter(([path]) => path === target)).toHaveLength(0);
	} finally {
		reads.mockRestore();
		lstats.mockRestore();
	}
	expect(text("b.ts")).toBe("two\n");
});

test("byte-only files and LFS pointers are not editable even with a matching hash", () => {
	const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
	put("img.png", png);
	expect(() => save("img.png", "text\n", hash(png))).toThrow(
		expect.objectContaining({ code: "NOT_EDITABLE" }),
	);
	put("big.bin", LFS_POINTER);
	expect(() => save("big.bin", "text\n", hash(LFS_POINTER))).toThrow(
		expect.objectContaining({ code: "NOT_EDITABLE" }),
	);
	expect(readFileSync(join(root, "img.png"))).toEqual(Buffer.from(png));
});

test("a directory is not editable", () => {
	mkdirSync(join(root, "dir"));
	expect(() => save("dir", "x", hash("x"))).toThrow(
		expect.objectContaining({ code: "NOT_EDITABLE" }),
	);
});

test("content over the cap is refused; content exactly at the cap is written", () => {
	put("big.txt", "");
	expect(() => save("big.txt", "a".repeat(FILE_WRITE_MAX_BYTES + 1), hash(""))).toThrow(
		expect.objectContaining({ code: "FILE_TOO_LARGE" }),
	);
	expect(() => save("big.txt", "é".repeat(FILE_WRITE_MAX_BYTES / 2 + 1), hash(""))).toThrow(
		expect.objectContaining({ code: "FILE_TOO_LARGE" }),
	);
	expect(save("big.txt", "a".repeat(FILE_WRITE_MAX_BYTES), hash("")).result).toMatchObject({
		status: "written",
	});
});

test("paths outside the worktree and inside .git are refused", () => {
	expect(() => save("../escape.txt", "x", null)).toThrow("Path escapes the worktree");
	expect(() => save(".git/config", "x", null)).toThrow("The .git directory is not readable");
});

test("malformed params are refused before any read", () => {
	put("a.ts", "one\n");
	expect(() =>
		writeTextFile({ workspaceId: "w1", path: "a.ts", content: 1, expect: { hash: null } } as never),
	).toThrow("content must be a string");
	expect(() => writeTextFile({ workspaceId: "w1", path: "a.ts", content: "x" } as never)).toThrow(
		"expect.hash must be a string or null",
	);
});

test.skipIf(!POSIX)("an atomic save replaces the inode and keeps the mode", () => {
	const abs = put("run.sh", "echo one\n");
	chmodSync(abs, 0o755);
	const before = statSync(abs);
	save("run.sh", "echo two\n", hash("echo one\n"));
	const after = statSync(abs);
	expect(after.ino).not.toBe(before.ino);
	expect(after.mode & 0o777).toBe(0o755);
	expect(text("run.sh")).toBe("echo two\n");
});

function otherGroup(): number | undefined {
	if (!POSIX) return undefined;
	const taken = new Set([statSync(tmpdir()).gid, process.getgid?.()]);
	return process.getgroups?.().find((gid) => !taken.has(gid));
}

const OTHER_GID = otherGroup();

test.skipIf(OTHER_GID === undefined)("an atomic save keeps the file's group", () => {
	const gid = OTHER_GID ?? -1;
	const abs = put("shared.txt", "one\n");
	chmodSync(abs, 0o664);
	chownSync(abs, -1, gid);
	const before = statSync(abs);
	save("shared.txt", "two\n", hash("one\n"));
	const after = statSync(abs);
	expect(after.ino).not.toBe(before.ino);
	expect(after.gid).toBe(gid);
	expect(after.mode & 0o777).toBe(0o664);
});

test.skipIf(!POSIX)("a hard-linked file is written in place, so both names see the text", () => {
	const abs = put("a.ts", "one\n");
	linkSync(abs, join(root, "b.ts"));
	const before = statSync(abs);
	save("a.ts", "two\n", hash("one\n"));
	expect(statSync(abs).ino).toBe(before.ino);
	expect(text("b.ts")).toBe("two\n");
});

test.skipIf(!POSIX)("a symlink inside the worktree stays a link and its target updates", () => {
	mkdirSync(join(root, "src"));
	put("src/real.ts", "one\n");
	symlinkSync("src/real.ts", join(root, "alias.ts"));
	save("alias.ts", "two\n", hash("one\n"));
	expect(lstatSync(join(root, "alias.ts")).isSymbolicLink()).toBe(true);
	expect(text("src/real.ts")).toBe("two\n");
	expect(leftovers(join(root, "src"))).toEqual([]);
});

test.skipIf(!POSIX)("a symlink that escapes the worktree is refused", () => {
	const outside = join(dataDir, "outside.txt");
	writeFileSync(outside, "secret\n");
	symlinkSync(outside, join(root, "leak.txt"));
	expect(() => save("leak.txt", "x", hash("secret\n"))).toThrow("Path escapes the worktree");
	expect(readFileSync(outside, "utf8")).toBe("secret\n");
});

test.skipIf(!POSIX)("a dangling symlink is missing, and a create through it is refused", () => {
	symlinkSync(join(dataDir, "nowhere.txt"), join(root, "dangling.txt"));
	expect(save("dangling.txt", "x", hash("x")).result).toEqual({ status: "missing" });
	expect(() => save("dangling.txt", "x", null)).toThrow(
		expect.objectContaining({ code: "NOT_EDITABLE" }),
	);
	expect(existsSync(join(dataDir, "nowhere.txt"))).toBe(false);
});

test.skipIf(!POSIX)("a FIFO is not editable and is never opened", () => {
	const made = Bun.spawnSync(["mkfifo", join(root, "pipe")]);
	expect(made.success).toBe(true);
	expect(() => save("pipe", "x", hash("x"))).toThrow(
		expect.objectContaining({ code: "NOT_EDITABLE" }),
	);
});

test.skipIf(ROOT_USER)("a read-only file is readonly even in a writable folder", () => {
	const abs = put("locked.ts", "one\n");
	chmodSync(abs, 0o444);
	expect(save("locked.ts", "two\n", hash("one\n"))).toEqual({
		result: { status: "readonly" },
		changed: false,
	});
	expect(text("locked.ts")).toBe("one\n");
	expect(statSync(abs).mode & 0o777).toBe(0o444);
	expect(leftovers()).toEqual([]);
	chmodSync(abs, 0o644);
});

test.skipIf(!POSIX || ROOT_USER)("a create in a read-only folder is readonly", () => {
	mkdirSync(join(root, "ro"));
	chmodSync(join(root, "ro"), 0o555);
	try {
		expect(save("ro/new.ts", "x", null)).toEqual({
			result: { status: "readonly" },
			changed: false,
		});
		expect(save("ro/sub/new.ts", "x", null)).toEqual({
			result: { status: "readonly" },
			changed: false,
		});
		expect(readdirSync(join(root, "ro"))).toEqual([]);
	} finally {
		chmodSync(join(root, "ro"), 0o755);
	}
});

test.skipIf(!POSIX || ROOT_USER)(
	"a writable file in a read-only folder is written in place",
	() => {
		const abs = put("a.ts", "one\n");
		const before = statSync(abs);
		chmodSync(root, 0o555);
		expect(save("a.ts", "two\n", hash("one\n")).result).toMatchObject({ status: "written" });
		chmodSync(root, 0o755);
		expect(statSync(abs).ino).toBe(before.ino);
		expect(text("a.ts")).toBe("two\n");
		expect(leftovers()).toEqual([]);
	},
);
