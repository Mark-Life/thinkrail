import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
import { linkSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceFile, writeStrategy } from "./replace";

const POSIX = process.platform !== "win32";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "trpi-fs-replace-test-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

test("the strategy is in-place for hard links and other users' files", () => {
	expect(writeStrategy({ nlink: 1, uid: 501 }, 501)).toBe("atomic");
	expect(writeStrategy({ nlink: 2, uid: 501 }, 501)).toBe("inPlace");
	expect(writeStrategy({ nlink: 1, uid: 0 }, 501)).toBe("inPlace");
	expect(writeStrategy({ nlink: 1, uid: 0 }, undefined)).toBe("atomic");
	expect(writeStrategy({ nlink: 3, uid: 0 }, undefined)).toBe("inPlace");
});

test("a missing file is created with its parent folders and the mode", () => {
	const target = join(dir, "a/b/new.txt");
	replaceFile(target, new TextEncoder().encode("x\n"), 0o640, null);
	expect(readFileSync(target, "utf8")).toBe("x\n");
	if (POSIX) expect(statSync(target).mode & 0o777).toBe(0o640);
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
