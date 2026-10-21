import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { processRunnerInterruption, runE2eProcess } from "../../processRunner";
import { buildEnv } from "./env";
import type { Artifact, Sha } from "./types";

const LOCK_POLL_MS = 500;
const LOCK_TIMEOUT_MS = 60 * 60 * 1000;
const MARKER = ".perf-built.json";

interface BuiltEntry {
	inputs: readonly string[];
	bunVersion: string;
	builtAt: string;
}

interface BuiltMarker {
	install?: { lockHash: string; bunVersion: string };
	artifacts: Partial<Record<Artifact["key"], BuiltEntry>>;
}

export function cacheRoot() {
	return resolve(process.env.THINKRAIL_PERF_CACHE ?? join(homedir(), ".cache", "thinkrail-perf"));
}

function cachePaths(root = cacheRoot()) {
	return {
		root,
		repo: join(root, "repo.git"),
		worktrees: join(root, "wt"),
		locks: join(root, "locks"),
	};
}

export function git(cwd: string, ...args: string[]) {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

export function resolveSha(toolRoot: string, ref: string): Sha {
	try {
		return git(toolRoot, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`) as Sha;
	} catch {
		throw new Error(`${ref}: SHA not found; fetch it`);
	}
}

export function toolState(toolRoot: string) {
	return {
		sha: git(toolRoot, "rev-parse", "HEAD"),
		dirty: git(toolRoot, "status", "--porcelain").length > 0,
	};
}

function ensureCacheRepo(toolRoot: string) {
	const { repo } = cachePaths();
	if (!existsSync(join(repo, "HEAD"))) {
		mkdirSync(repo, { recursive: true });
		git(repo, "init", "--bare", "--quiet");
	}
	const objects = join(
		git(toolRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"),
		"objects",
	);
	const alternates = join(repo, "objects", "info", "alternates");
	const current = existsSync(alternates) ? readFileSync(alternates, "utf8").split("\n") : [];
	const own = realpathSync(join(repo, "objects")) === realpathSync(objects);
	if (!own && !current.includes(objects)) {
		mkdirSync(join(repo, "objects", "info"), { recursive: true });
		appendFileSync(alternates, `${objects}\n`);
	}
	return repo;
}

export function worktreeDir(sha: Sha) {
	return join(cachePaths().worktrees, sha);
}

function ensureWorktree(repo: string, sha: Sha) {
	const dir = worktreeDir(sha);
	if (existsSync(join(dir, ".git"))) {
		if (git(dir, "rev-parse", "HEAD") === sha) return dir;
		throw new Error(`${dir} is not at ${sha}; run perf:compare clean ${sha}`);
	}
	try {
		git(repo, "cat-file", "-e", `${sha}^{commit}`);
	} catch {
		throw new Error(`${sha}: SHA not found; fetch it`);
	}
	const staging = `${dir}.tmp`;
	rmSync(dir, { recursive: true, force: true });
	rmSync(staging, { recursive: true, force: true });
	git(repo, "worktree", "prune");
	git(repo, "worktree", "add", "--detach", "--quiet", staging, sha);
	git(repo, "worktree", "move", staging, dir);
	return dir;
}

function pidAlive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function lockOwner(dir: string) {
	try {
		const owner = Number(readFileSync(join(dir, "pid"), "utf8"));
		return Number.isInteger(owner) && owner > 0 ? owner : null;
	} catch {
		return null;
	}
}

export function tryLock(dir: string) {
	const staging = `${dir}.${process.pid}.tmp`;
	rmSync(staging, { recursive: true, force: true });
	try {
		mkdirSync(staging);
		writeFileSync(join(staging, "pid"), String(process.pid));
		renameSync(staging, dir);
		return true;
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
		const owner = lockOwner(dir);
		if (owner === null || !pidAlive(owner)) rmSync(dir, { recursive: true, force: true });
		return false;
	}
}

async function withShaLock<T>(sha: Sha, task: () => Promise<T>) {
	const { locks } = cachePaths();
	mkdirSync(locks, { recursive: true });
	const dir = join(locks, sha);
	const started = Date.now();
	let announced = false;
	while (!tryLock(dir)) {
		if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error(`timed out waiting for ${dir}`);
		if (!announced)
			console.error(`perf:compare: waiting for another prepare of ${sha.slice(0, 10)}`);
		announced = true;
		await new Promise((done) => setTimeout(done, LOCK_POLL_MS));
	}
	try {
		return await task();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function usersDir(sha: Sha) {
	return join(cachePaths().locks, `${sha}.users`);
}

function otherLiveUsers(sha: Sha) {
	const dir = usersDir(sha);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => {
		const pid = Number(name);
		if (pid === process.pid) return false;
		if (Number.isInteger(pid) && pidAlive(pid)) return true;
		rmSync(join(dir, name), { force: true });
		return false;
	});
}

function refuseIfUsed(sha: Sha, action: string) {
	const users = otherLiveUsers(sha);
	if (users.length === 0) return;
	throw new Error(`cannot ${action} ${sha.slice(0, 10)}: in use by pid ${users.join(", ")}`);
}

export function releaseSha(sha: Sha) {
	rmSync(join(usersDir(sha), String(process.pid)), { force: true });
}

function readMarker(dir: string): BuiltMarker {
	const file = join(dir, MARKER);
	return existsSync(file)
		? (JSON.parse(readFileSync(file, "utf8")) as BuiltMarker)
		: { artifacts: {} };
}

function writeMarker(dir: string, marker: BuiltMarker) {
	writeFileSync(join(dir, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
}

function artifactInputs(artifact: Artifact) {
	return [artifact.cwd, ...artifact.command];
}

function sameInputs(entry: BuiltEntry | undefined, inputs: readonly string[]) {
	return (
		entry !== undefined &&
		entry.bunVersion === Bun.version &&
		JSON.stringify(entry.inputs) === JSON.stringify(inputs)
	);
}

export async function runBun(command: string[], label: string, env = buildEnv()) {
	const result = await runE2eProcess([process.execPath, ...command], { env, stdout: "pipe" });
	if (result.exitCode === 0) return;
	process.stderr.write(result.stdout.split("\n").slice(-40).join("\n"));
	throw new Error(`${label} failed (exit ${result.exitCode})`);
}

async function install(dir: string, marker: BuiltMarker, rebuild: boolean) {
	const lockHash = createHash("sha256")
		.update(readFileSync(join(dir, "bun.lock")))
		.digest("hex");
	const fresh = marker.install?.lockHash === lockHash && marker.install.bunVersion === Bun.version;
	if (fresh && !rebuild && existsSync(join(dir, "node_modules"))) return marker;
	const { install: _stale, ...pending } = marker;
	writeMarker(dir, pending);
	console.error(`perf:compare: bun install in ${dir}`);
	await runBun(["install", "--frozen-lockfile", "--cwd", dir], `bun install at ${dir}`);
	return { ...pending, install: { lockHash, bunVersion: Bun.version } };
}

export async function prepareSha(input: {
	toolRoot: string;
	sha: Sha;
	artifacts: readonly Artifact[];
	rebuild: boolean;
}) {
	const repo = ensureCacheRepo(input.toolRoot);
	return withShaLock(input.sha, async () => {
		if (input.rebuild) refuseIfUsed(input.sha, "rebuild");
		const dir = ensureWorktree(repo, input.sha);
		let marker = await install(dir, readMarker(dir), input.rebuild);
		writeMarker(dir, marker);
		const failed = new Map<Artifact["key"], string>();
		for (const artifact of input.artifacts) {
			if (!input.rebuild && sameInputs(marker.artifacts[artifact.key], artifactInputs(artifact)))
				continue;
			const { [artifact.key]: _stale, ...kept } = marker.artifacts;
			marker = { ...marker, artifacts: kept };
			writeMarker(dir, marker);
			console.error(`perf:compare: building ${artifact.key} for ${input.sha.slice(0, 10)}`);
			try {
				await runBun(
					["run", "--cwd", join(dir, artifact.cwd), ...artifact.command],
					`${artifact.key} build`,
				);
			} catch (error) {
				if (processRunnerInterruption()) throw error;
				failed.set(artifact.key, error instanceof Error ? error.message : String(error));
				continue;
			}
			const entry = {
				inputs: artifactInputs(artifact),
				bunVersion: Bun.version,
				builtAt: new Date().toISOString(),
			};
			marker = { ...marker, artifacts: { ...marker.artifacts, [artifact.key]: entry } };
			writeMarker(dir, marker);
		}
		mkdirSync(usersDir(input.sha), { recursive: true });
		writeFileSync(join(usersDir(input.sha), String(process.pid)), "");
		return { appRoot: dir, failed };
	});
}

export function cleanSha(sha: Sha) {
	return withShaLock(sha, async () => {
		refuseIfUsed(sha, "clean");
		const { repo } = cachePaths();
		const dir = worktreeDir(sha);
		if (existsSync(repo) && existsSync(dir)) git(repo, "worktree", "remove", "--force", dir);
		rmSync(dir, { recursive: true, force: true });
		if (existsSync(repo)) git(repo, "worktree", "prune");
		return dir;
	});
}

export function cleanAll() {
	const { root, repo, worktrees, locks } = cachePaths();
	if (!existsSync(root)) return root;
	const used = existsSync(locks)
		? readdirSync(locks).filter((name) => name.endsWith(".users"))
		: [];
	for (const name of used) refuseIfUsed(name.slice(0, -".users".length) as Sha, "clean");
	const looksLikeCache = existsSync(repo) || existsSync(worktrees);
	if (root === homedir() || dirname(root) === root || !looksLikeCache) {
		throw new Error(`refusing to remove ${root}: not a perf:compare cache`);
	}
	rmSync(root, { recursive: true, force: true });
	return root;
}
