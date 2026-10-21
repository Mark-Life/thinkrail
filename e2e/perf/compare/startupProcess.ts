import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Env } from "./types";

const POLL_MS = 10;
const STOP_GRACE_MS = 2_000;
const RC_FILES = [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".profile", ".bashrc"];

export interface Launch {
	command: readonly string[];
	env: Env;
	cwd: string;
}

export interface ReadyProbes {
	stdout?: RegExp;
	health?: number;
	file?: string;
}

export type ReadyTimes = Record<keyof ReadyProbes, number | undefined>;

export function freePort() {
	return new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
		});
	});
}

export function prepareHome(home: string) {
	mkdirSync(home, { recursive: true });
	for (const name of RC_FILES) writeFileSync(join(home, name), "");
}

function signalGroup(pid: number, signal: NodeJS.Signals) {
	for (const target of [-pid, pid]) {
		try {
			process.kill(target, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
}

function start(launch: Launch) {
	const [executable, ...args] = launch.command;
	if (!executable) throw new Error("empty startup command");
	if (!existsSync(executable)) throw new Error(`${executable} not found`);
	const startedAt = performance.now();
	const child = spawn(executable, args, {
		cwd: launch.cwd,
		env: launch.env,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const pid = child.pid;
	if (pid === undefined) throw new Error(`could not start ${executable}`);
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const exited = new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
	});
	let done = false;
	void exited.finally(() => {
		done = true;
	});
	return {
		pid,
		startedAt,
		exited,
		onStdout: (listener: (text: string, at: number) => void) =>
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
				listener(stdout, performance.now());
			}),
		exitedYet: () => done,
		output: () => ({ stdout, stderr }),
		async stop(extraPids: readonly number[] = []) {
			for (const extra of extraPids) signalGroup(extra, "SIGTERM");
			if (done) {
				signalGroup(pid, "SIGTERM");
				return;
			}
			signalGroup(pid, "SIGTERM");
			const force = setTimeout(() => {
				signalGroup(pid, "SIGKILL");
				for (const extra of extraPids) signalGroup(extra, "SIGKILL");
			}, STOP_GRACE_MS);
			await exited.catch(() => 1);
			clearTimeout(force);
		},
	};
}

function tail(text: string) {
	return text.trim().split("\n").slice(-5).join(" | ");
}

export async function timeToExit(launch: Launch, timeoutMs: number) {
	const proc = start(launch);
	proc.onStdout(() => {});
	const timer = setTimeout(() => void proc.stop(), timeoutMs);
	const code = await proc.exited;
	const elapsed = performance.now() - proc.startedAt;
	clearTimeout(timer);
	const { stdout, stderr } = proc.output();
	if (code !== 0) throw new Error(`exit ${code} after ${Math.round(elapsed)} ms: ${tail(stderr)}`);
	if (stdout.trim() === "") throw new Error("printed nothing");
	return elapsed;
}

async function healthy(port: number) {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/health`, {
			signal: AbortSignal.timeout(500),
		});
		return response.ok;
	} catch {
		return false;
	}
}

function readJson(path: string) {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export async function timeToReady(launch: Launch, probes: ReadyProbes, timeoutMs: number) {
	const proc = start(launch);
	const times: ReadyTimes = { stdout: undefined, health: undefined, file: undefined };
	let port = probes.health;
	let ready: Record<string, unknown> | undefined;
	proc.onStdout((text, at) => {
		const match = probes.stdout?.exec(text);
		if (!match || times.stdout !== undefined) return;
		times.stdout = at - proc.startedAt;
		const reported = Number(match[1]);
		if (Number.isInteger(reported) && reported > 0) port = reported;
	});
	const pending = () =>
		(probes.stdout !== undefined && times.stdout === undefined) ||
		(probes.health !== undefined && times.health === undefined) ||
		(probes.file !== undefined && times.file === undefined);
	try {
		while (pending()) {
			const elapsed = performance.now() - proc.startedAt;
			if (proc.exitedYet()) {
				const { stderr } = proc.output();
				throw new Error(`exited before ready after ${Math.round(elapsed)} ms: ${tail(stderr)}`);
			}
			if (elapsed > timeoutMs) throw new Error(`not ready after ${timeoutMs} ms`);
			if (probes.file !== undefined && times.file === undefined) {
				ready = readJson(probes.file);
				if (ready) times.file = performance.now() - proc.startedAt;
			}
			if (port !== undefined && times.health === undefined && (await healthy(port))) {
				times.health = performance.now() - proc.startedAt;
			}
			await Bun.sleep(POLL_MS);
		}
		return times;
	} finally {
		const extra = ["pid", "launcherPid"].flatMap((key) => {
			const value = ready?.[key];
			return typeof value === "number" && Number.isInteger(value) && value > 0 ? [value] : [];
		});
		await proc.stop(extra);
	}
}
