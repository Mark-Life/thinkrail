import { posix } from "node:path";

interface GitInput {
	cwd: string;
	args: readonly string[];
}

export class GitError extends Error {
	readonly args: readonly string[];
	constructor(args: readonly string[], detail: string) {
		super(`git ${args.join(" ")}: ${detail.trim()}`);
		this.args = args;
	}
}

export function git({ cwd, args }: GitInput) {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new GitError(args, result.stderr.toString());
	return result.stdout.toString();
}

export function tryGit(input: GitInput) {
	try {
		return git(input);
	} catch (error) {
		if (error instanceof GitError) return undefined;
		throw error;
	}
}

export function repoRoot(cwd: string) {
	return git({ cwd, args: ["rev-parse", "--show-toplevel"] }).trim();
}

export function commonDir(root: string) {
	return git({
		cwd: root,
		args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
	}).trim();
}

export function resolveCommit(input: { root: string; ref: string }) {
	return git({
		cwd: input.root,
		args: ["rev-parse", "--verify", `${input.ref}^{commit}`],
	}).trim();
}

export function mergeBase(input: { root: string; a: string; b: string }) {
	return git({ cwd: input.root, args: ["merge-base", input.a, input.b] }).trim();
}

export function defaultBranchRef(root: string) {
	for (const ref of ["main", "origin/main", "master", "origin/master"]) {
		if (tryGit({ cwd: root, args: ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`] })) {
			return ref;
		}
	}
	throw new Error("No main or master branch found. Pass a base ref.");
}

export function parseStatus(output: string) {
	const files: string[] = [];
	const entries = output.split("\0");
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (!entry) continue;
		const status = entry.slice(0, 2);
		files.push(entry.slice(3));
		if (status.includes("R") || status.includes("C")) index++;
	}
	return files;
}

export function dirtyFiles(root: string) {
	return parseStatus(
		git({ cwd: root, args: ["status", "--porcelain", "-z", "--untracked-files=all"] }),
	);
}

export function worktreePaths(root: string) {
	return git({ cwd: root, args: ["ls-files", "-z", "-c", "-o", "--exclude-standard"] })
		.split("\0")
		.filter(Boolean);
}

export function commitPaths(input: { root: string; sha: string }) {
	const output = git({ cwd: input.root, args: ["ls-tree", "-r", "-z", input.sha] });
	return output.split("\0").flatMap((line) => {
		const tab = line.indexOf("\t");
		if (tab < 0) return [];
		return line.startsWith("100") ? [line.slice(tab + 1)] : [];
	});
}

const CHURN_WINDOW_SECONDS = 90 * 24 * 60 * 60;

export function commitChurn(input: { root: string; sha: string }) {
	const { root, sha } = input;
	const churn = new Map<string, number>();
	const commitTime = Number(git({ cwd: root, args: ["show", "-s", "--format=%ct", sha] }).trim());
	const since = commitTime - CHURN_WINDOW_SECONDS;
	const output = tryGit({
		cwd: root,
		args: ["log", `--since=${since}`, "--name-only", "--no-renames", "--format=", sha],
	});
	for (const line of (output ?? "").split("\n")) {
		if (line) churn.set(line, (churn.get(line) ?? 0) + 1);
	}
	return churn;
}

export function changedPaths(input: { root: string; base: string; head?: string }) {
	const { root, base, head } = input;
	const args = ["diff", "--name-only", "-z", "--no-renames", base, ...(head ? [head] : [])];
	return git({ cwd: root, args }).split("\0").filter(Boolean);
}

const CONFIG_NAMES = new Set(["package.json", "SPEC.md"]);

export function affectsGraph(path: string) {
	const name = posix.basename(path);
	return (
		/\.(tsx?|mts|cts|json)$/.test(name) || CONFIG_NAMES.has(name) || /^tsconfig.*\.json$/.test(name)
	);
}
