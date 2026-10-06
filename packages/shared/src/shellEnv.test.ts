import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localeRepair, pathLooksComplete, repairShellEnv, resolveShellEnv } from "./shellEnv";

const scratch = mkdtempSync(join(tmpdir(), "shell-env-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function fakeShell(name: string, body: string): string {
	const path = join(scratch, name);
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

const loginPath = "/home/u/.bun/bin:/usr/bin:/bin";
const printingShell = fakeShell("printing", `printf 'HOME=/home/u\\0PATH=${loginPath}\\0'`);

test("pathLooksComplete detects user dirs", () => {
	expect(pathLooksComplete("/usr/bin:/usr/local/bin")).toBe(true);
	expect(pathLooksComplete("/opt/homebrew/bin:/usr/bin")).toBe(true);
	expect(pathLooksComplete("/Users/x/.bun/bin:/usr/bin")).toBe(true);
	expect(pathLooksComplete("/usr/bin:/bin")).toBe(false);
});

test("a stripped PATH is replaced by the login shell's PATH", async () => {
	const env: Record<string, string | undefined> = {
		PATH: "/usr/bin:/bin",
		SHELL: printingShell,
		LANG: "en_US.UTF-8",
	};
	await repairShellEnv(env, "linux");
	expect(env.PATH).toBe(loginPath);
});

test("a complete PATH never starts the login shell", async () => {
	const marker = join(scratch, "spawned");
	const env: Record<string, string | undefined> = {
		PATH: "/opt/homebrew/bin:/usr/bin",
		SHELL: fakeShell("marking", `touch ${marker}`),
		LANG: "en_US.UTF-8",
	};
	await repairShellEnv(env, "linux");
	expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
	expect(await Bun.file(marker).exists()).toBe(false);
});

test("a failing login shell leaves PATH untouched", async () => {
	const env: Record<string, string | undefined> = {
		PATH: "/usr/bin:/bin",
		SHELL: fakeShell("failing", "exit 1"),
		LANG: "en_US.UTF-8",
	};
	await repairShellEnv(env, "linux");
	expect(env.PATH).toBe("/usr/bin:/bin");
});

test("the login shell probe does not block the event loop", async () => {
	const env: Record<string, string | undefined> = {
		PATH: "/usr/bin:/bin",
		SHELL: fakeShell("slow", `sleep 0.3; printf 'PATH=${loginPath}\\0'`),
		LANG: "en_US.UTF-8",
	};
	const order: string[] = [];
	const repair = repairShellEnv(env, "linux").then(() => order.push("repaired"));
	await Bun.sleep(20);
	order.push("timer");
	await repair;
	expect(order).toEqual(["timer", "repaired"]);
	expect(env.PATH).toBe(loginPath);
});

test("a background job holding stdout neither delays nor drops the PATH", async () => {
	const env: Record<string, string | undefined> = {
		PATH: "/usr/bin:/bin",
		SHELL: fakeShell("forking", `sleep 3 &\nprintf 'PATH=${loginPath}\\0'`),
		LANG: "en_US.UTF-8",
	};
	const started = performance.now();
	await repairShellEnv(env, "linux");
	expect(env.PATH).toBe(loginPath);
	expect(performance.now() - started).toBeLessThan(1500);
});

test("localeRepair supplies a UTF-8 locale only when none is configured", () => {
	expect(localeRepair({}, "linux")).toBe("C.UTF-8");
	expect(localeRepair({}, "darwin")).toBe("en_US.UTF-8");

	expect(localeRepair({ LANG: "en_GB.UTF-8" }, "linux")).toBeNull();
	expect(localeRepair({ LANG: "C" }, "linux")).toBeNull();
	expect(localeRepair({ LC_ALL: "de_DE.UTF-8" }, "linux")).toBeNull();
	expect(localeRepair({ LC_CTYPE: "ru_RU.UTF-8" }, "linux")).toBeNull();
});

test("a missing locale gets LANG only, even when PATH short-circuits", async () => {
	const env: Record<string, string | undefined> = { PATH: "/opt/homebrew/bin:/usr/bin" };
	await repairShellEnv(env, "linux");
	expect(env.LANG).toBe("C.UTF-8");
	expect(env.LC_ALL).toBeUndefined();
	expect(env.LC_CTYPE).toBeUndefined();
});

test("an existing locale is left untouched", async () => {
	const env: Record<string, string | undefined> = {
		LANG: "ru_RU.UTF-8",
		PATH: "/opt/homebrew/bin:/usr/bin",
	};
	await repairShellEnv(env, "linux");
	expect(env.LANG).toBe("ru_RU.UTF-8");
});

test("win32 is a no-op", async () => {
	const env: Record<string, string | undefined> = { PATH: "C:\\Windows", SHELL: printingShell };
	await repairShellEnv(env, "win32");
	expect(env).toEqual({ PATH: "C:\\Windows", SHELL: printingShell });
});

test("every resolveShellEnv caller awaits the same run", async () => {
	const run = resolveShellEnv();
	expect(resolveShellEnv()).toBe(run);
	await run;
});
