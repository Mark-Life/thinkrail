import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermeticWarning, userStateStamp } from "./env";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir() {
	const dir = mkdtempSync(join(tmpdir(), "perf-compare-env-"));
	dirs.push(dir);
	mkdirSync(join(dir, "logs"));
	writeFileSync(join(dir, "config.json"), "{}");
	return dir;
}

test("the user-state guard sees in-place rewrites and nested writes", () => {
	const dir = stateDir();
	const before = userStateStamp(dir);
	expect(hermeticWarning(before, dir)).toBeNull();
	writeFileSync(join(dir, "config.json"), '{"changed":true}');
	writeFileSync(join(dir, "logs", "host.log"), "line");
	const warning = hermeticWarning(before, dir);
	expect(warning).toContain("config.json");
	expect(warning).toContain(join("logs", "host.log"));
});

test("the user-state guard sees the directory appear", () => {
	const dir = join(stateDir(), "missing");
	const before = userStateStamp(dir);
	expect(before).toBeNull();
	mkdirSync(dir);
	expect(hermeticWarning(before, dir)).not.toBeNull();
});
