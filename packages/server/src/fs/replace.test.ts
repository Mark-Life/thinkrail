import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
import {
	chmodSync,
	linkSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFile, replaceFile, writeStrategy } from "./replace";

const POSIX = process.platform !== "win32";
const ROOT_USER = process.getuid?.() === 0;
const BYTES = new TextEncoder();

function snapshot(target: string) {
	return { stat: statSync(target), bytes: readFileSync(target) };
}

function hardLinked(content: string) {
	const target = join(dir, "a.txt");
	writeFileSync(target, content);
	chmodSync(target, 0o644);
	linkSync(target, join(dir, "b.txt"));
	return target;
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "trpi-fs-replace-test-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

test("the strategy is in-place for hard links and for other users' files that keep their mode", () => {
	const file = 0o100644;
	expect(writeStrategy({ nlink: 1, uid: 501, mode: file }, 0o644, 501)).toBe("atomic");
	expect(writeStrategy({ nlink: 2, uid: 501, mode: file }, 0o755, 501)).toBe("inPlace");
	expect(writeStrategy({ nlink: 1, uid: 0, mode: file }, 0o644, 501)).toBe("inPlace");
	expect(writeStrategy({ nlink: 1, uid: 0, mode: file }, 0o755, 501)).toBe("atomic");
	expect(writeStrategy({ nlink: 1, uid: 0, mode: file }, 0o644, undefined)).toBe("atomic");
	expect(writeStrategy({ nlink: 3, uid: 0, mode: file }, 0o644, undefined)).toBe("inPlace");
});

test("a create sets the exact mode and never replaces a file that already exists", () => {
	const target = join(dir, "new.txt");
	createFile(target, BYTES.encode("x\n"), 0o640);
	expect(readFileSync(target, "utf8")).toBe("x\n");
	if (POSIX) expect(statSync(target).mode & 0o777).toBe(0o640);
	expect(() => createFile(target, BYTES.encode("y\n"), 0o640)).toThrow(
		expect.objectContaining({ code: "EEXIST" }),
	);
	expect(readFileSync(target, "utf8")).toBe("x\n");
});

test.skipIf(ROOT_USER)(
	"a read-only file is refused before any write, whatever the strategy",
	() => {
		const target = join(dir, "locked.txt");
		writeFileSync(target, "one\n");
		chmodSync(target, 0o444);
		try {
			expect(() => replaceFile(target, BYTES.encode("two\n"), 0o644, snapshot(target))).toThrow(
				expect.objectContaining({ code: expect.stringMatching(/^(EACCES|EPERM)$/) }),
			);
			expect(readFileSync(target, "utf8")).toBe("one\n");
			expect(statSync(target).mode & 0o777).toBe(0o444);
		} finally {
			chmodSync(target, 0o644);
		}
	},
);

test.skipIf(!POSIX)("an in-place write that fails keeps the file's old mode", () => {
	const target = hardLinked("original\n");
	const spy = spyOn(nodeFs, "writeFileSync").mockImplementationOnce(() => {
		throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
	});
	try {
		expect(() => replaceFile(target, BYTES.encode("new\n"), 0o755, snapshot(target))).toThrow(
			expect.objectContaining({ code: "ENOSPC" }),
		);
	} finally {
		spy.mockRestore();
	}
	expect(readFileSync(target, "utf8")).toBe("original\n");
	expect(statSync(target).mode & 0o777).toBe(0o644);
});

test.skipIf(!POSIX)("an in-place write whose chmod fails puts the old bytes back", () => {
	const target = hardLinked("original\n");
	const spy = spyOn(nodeFs, "chmodSync").mockImplementationOnce(() => {
		throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
	});
	try {
		expect(() => replaceFile(target, BYTES.encode("new\n"), 0o755, snapshot(target))).toThrow(
			expect.objectContaining({ code: "EPERM" }),
		);
	} finally {
		spy.mockRestore();
	}
	expect(readFileSync(target, "utf8")).toBe("original\n");
	expect(statSync(target).mode & 0o777).toBe(0o644);
});

test.skipIf(!POSIX)("an in-place write that fails mid-way puts the caller's bytes back", () => {
	const target = join(dir, "a.txt");
	writeFileSync(target, "original\n");
	linkSync(target, join(dir, "b.txt"));
	const realWrite = nodeFs.writeFileSync;
	let calls = 0;
	const spy = spyOn(nodeFs, "writeFileSync").mockImplementation((path, data, options) => {
		calls += 1;
		if (calls > 1) return realWrite(path, data, options);
		realWrite(path, "partial");
		throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
	});
	try {
		const current = { stat: statSync(target), bytes: readFileSync(target) };
		expect(() =>
			replaceFile(target, new TextEncoder().encode("new content\n"), 0o644, current),
		).toThrow(expect.objectContaining({ code: "ENOSPC" }));
	} finally {
		spy.mockRestore();
	}
	expect(readFileSync(target, "utf8")).toBe("original\n");
	expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("original\n");
});
