import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Env } from "./types";

const SAMPLE_PASSTHROUGH = ["PATH", "TMPDIR", "LANG", "TERM"] as const;
const BUILD_PASSTHROUGH = [...SAMPLE_PASSTHROUGH, "HOME", "USER", "SHELL"] as const;

function pick(names: readonly string[]): Env {
	return Object.fromEntries(
		names.flatMap((name) => {
			const value = process.env[name];
			return value === undefined ? [] : [[name, value]];
		}),
	);
}

function hermeticShell() {
	return existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh";
}

export function buildEnv(extra: Env = {}): Env {
	return { ...pick(BUILD_PASSTHROUGH), HUSKY: "0", ...extra };
}

export function hermeticEnv(stateDir: string, extra: Env = {}): Env {
	const dirs = {
		HOME: join(stateDir, "home"),
		THINKRAIL_DATA_DIR: join(stateDir, "data"),
		PI_CODING_AGENT_DIR: join(stateDir, "pi"),
		XDG_CACHE_HOME: join(stateDir, "cache"),
		XDG_CONFIG_HOME: join(stateDir, "config"),
		XDG_DATA_HOME: join(stateDir, "share"),
	};
	for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
	return {
		...pick(SAMPLE_PASSTHROUGH),
		...dirs,
		SHELL: hermeticShell(),
		PI_OFFLINE: "1",
		THINKRAIL_NO_ANALYTICS: "1",
		CI: "1",
		HUSKY: "0",
		...extra,
	};
}

export function userStateStamp() {
	const dir = join(homedir(), ".thinkrail");
	return existsSync(dir) ? statSync(dir).mtimeMs : null;
}

export function hermeticWarning(before: number | null) {
	const after = userStateStamp();
	return after === before
		? null
		: "~/.thinkrail changed during the run: a sample may have used real user state, or another ThinkRail process wrote it";
}
