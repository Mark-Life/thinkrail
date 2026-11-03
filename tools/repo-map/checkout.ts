import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import { affectsGraph, commitPaths, commonDir, git } from "./git";

interface Checkout {
	root: string;
	paths: string[];
	cleanup: () => void;
}

const ARCHIVE_CHUNK = 400;
const STALE_MS = 60 * 60 * 1000;
const TEMP_PREFIX = "tmp-";

function run(command: string[], cwd: string) {
	const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`${command.join(" ")}: ${result.stderr.toString().trim()}`);
	}
}

function chunks<T>(items: readonly T[], size: number) {
	const groups: T[][] = [];
	for (let start = 0; start < items.length; start += size) {
		groups.push(items.slice(start, start + size));
	}
	return groups;
}

function extract(input: { repo: string; sha: string; target: string; paths: readonly string[] }) {
	const { repo, sha, target, paths } = input;
	const archive = join(target, ".repo-map.tar");
	for (const group of chunks(paths, ARCHIVE_CHUNK)) {
		git({
			cwd: repo,
			args: ["--literal-pathspecs", "archive", "--format=tar", "-o", archive, sha, "--", ...group],
		});
		run(["tar", "-xf", archive, "-C", target], repo);
	}
	rmSync(archive, { force: true });
}

function liveDependencyRoots(repo: string) {
	const common = commonDir(repo);
	const main = dirname(common);
	return posix.basename(common) === ".git" && main !== repo ? [repo, main] : [repo];
}

function linkNodeModules(input: { repo: string; target: string; paths: readonly string[] }) {
	const { repo, target, paths } = input;
	const dirs = new Set(["."]);
	for (const path of paths) {
		if (posix.basename(path) === "package.json") dirs.add(posix.dirname(path));
	}
	const roots = liveDependencyRoots(repo);
	for (const dir of dirs) {
		const source = roots
			.map((root) => join(root, dir, "node_modules"))
			.find((candidate) => existsSync(candidate));
		if (!source) continue;
		mkdirSync(join(target, dir), { recursive: true });
		symlinkSync(source, join(target, dir, "node_modules"));
	}
}

export function sweepStaleCheckouts(cacheDir: string) {
	if (!existsSync(cacheDir)) return;
	const now = Date.now();
	for (const entry of readdirSync(cacheDir)) {
		if (!entry.startsWith(TEMP_PREFIX)) continue;
		const path = join(cacheDir, entry);
		if (now - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true });
	}
}

export function checkoutCommit(input: { repo: string; cacheDir: string; sha: string }) {
	const { repo, cacheDir, sha } = input;
	mkdirSync(cacheDir, { recursive: true });
	const root = mkdtempSync(join(cacheDir, `${TEMP_PREFIX}${sha.slice(0, 12)}-`));
	const cleanup = () => rmSync(root, { recursive: true, force: true });
	try {
		const paths = commitPaths({ root: repo, sha }).filter(affectsGraph);
		extract({ repo, sha, target: root, paths });
		linkNodeModules({ repo, target: root, paths });
		const checkout: Checkout = { root, paths, cleanup };
		return checkout;
	} catch (error) {
		cleanup();
		throw error;
	}
}
