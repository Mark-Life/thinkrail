import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
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

const USER_STATE_DIR = join(homedir(), ".thinkrail");

export function userStateStamp(dir = USER_STATE_DIR) {
	if (!existsSync(dir)) return null;
	const entries = readdirSync(dir, { recursive: true, encoding: "utf8" }).flatMap((path) => {
		try {
			const stat = lstatSync(join(dir, path));
			return [[path, `${stat.mtimeMs}:${stat.size}`] as const];
		} catch {
			return [];
		}
	});
	return new Map<string, string>(entries);
}

function changedPaths(before: Map<string, string> | null, after: Map<string, string> | null) {
	if (!before || !after) return before === after ? [] : ["."];
	const paths = new Set([...before.keys(), ...after.keys()]);
	return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

export function hermeticWarning(before: ReturnType<typeof userStateStamp>, dir = USER_STATE_DIR) {
	const changed = changedPaths(before, userStateStamp(dir));
	if (changed.length === 0) return null;
	const shown = changed.slice(0, 3).join(", ");
	const more = changed.length > 3 ? ` and ${changed.length - 3} more` : "";
	return `~/.thinkrail changed during the run (${shown}${more}): a sample may have used real user state, or another ThinkRail process wrote it`;
}
