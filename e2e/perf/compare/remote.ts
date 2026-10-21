import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { processRunnerInterruption, runE2eProcess } from "../../processRunner";
import { git, resolveSha, toolState } from "./checkout";
import { runCompare, selectSuites } from "./compare";
import { renderReport } from "./report";
import type { CompareOptions, CompareResult, Sha } from "./types";

const BOOTSTRAP = readFileSync(new URL("./bootstrap.sh", import.meta.url), "utf8");
const REMOTE_RUN = readFileSync(new URL("./remoteRun.sh", import.meta.url), "utf8");
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const SSH_OPTIONS = ["-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30"];

export function parseHost(value: string | undefined) {
	if (value === undefined || !HOST_PATTERN.test(value)) {
		throw new Error("--host needs local or an ssh alias (letters, digits, . _ @ -)");
	}
	return value;
}

export function shellQuote(value: string) {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function normalizeHost(name: string) {
	const lower = name.toLowerCase().replace(/\.$/, "");
	return /^[\d.]+$/.test(lower) ? lower : (lower.split(".")[0] ?? lower);
}

function sshHostname(host: string) {
	try {
		const config = execFileSync("ssh", ["-G", host], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return /^hostname (.+)$/m.exec(config)?.[1] ?? host;
	} catch {
		return host;
	}
}

export function isLocalHost(input: { host: string; localName: string; sshHostname: string }) {
	const local = normalizeHost(input.localName);
	return (
		input.host === "local" ||
		normalizeHost(input.host) === local ||
		normalizeHost(input.sshHostname) === local
	);
}

export function forwardArgs(options: CompareOptions) {
	return [
		"--suite",
		options.suites.join(","),
		...(options.scenarios ? ["--scenario", options.scenarios.join(",")] : []),
		...(options.rounds === null ? [] : ["--rounds", String(options.rounds)]),
		"--startup",
		options.startup.join(","),
		"--min-runs",
		String(options.minRuns),
		"--max-minutes",
		String(options.maxMinutes),
		"--threshold",
		String(options.threshold),
		"--cpu",
		String(options.cpu),
		"--browser",
		options.browser,
		...(options.strictProtocol ? ["--strict-protocol"] : []),
		...(options.rebuild ? ["--rebuild"] : []),
	];
}

export function requiredBrowsers(options: CompareOptions) {
	const names = selectSuites(options.suites).map((suite) => suite.name);
	const browsers = new Set<string>();
	if (names.includes("renders")) browsers.add("chromium");
	if (names.includes("waterfall")) browsers.add(options.browser);
	return [...browsers];
}

function remotePreflight(toolRoot: string, shas: Record<string, Sha>) {
	const tool = toolState(toolRoot);
	if (tool.dirty) {
		throw new Error("tool checkout is dirty: commit and push the tool commit before --host");
	}
	git(toolRoot, "fetch", "--quiet", "origin");
	const missing = Object.entries({ ...shas, tool: tool.sha as Sha }).filter(
		([, sha]) => git(toolRoot, "branch", "-r", "--contains", sha, "--list", "origin/*") === "",
	);
	if (missing.length > 0) {
		const list = missing.map(([label, sha]) => `${label} ${sha.slice(0, 10)}`).join(", ");
		throw new Error(`not on origin: ${list}; push the tool commit or the missing SHAs`);
	}
	return { toolSha: tool.sha as Sha, origin: git(toolRoot, "remote", "get-url", "origin") };
}

async function ssh(
	host: string,
	command: string,
	label: string,
	stdin: "ignore" | "pipe" = "ignore",
) {
	const result = await runE2eProcess(["ssh", ...SSH_OPTIONS, host, command], {
		stdin,
		stdout: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(`${host}: ${label} failed (exit ${result.exitCode})`);
	return result.stdout;
}

function script(source: string, name: string, args: readonly string[]) {
	return `bash -c ${shellQuote(source)} ${name} ${args.map(shellQuote).join(" ")}`;
}

async function runRemote(input: {
	host: string;
	origin: string;
	toolSha: Sha;
	base: Sha;
	head: Sha;
	options: CompareOptions;
}) {
	const { host, options } = input;
	const bootstrapArgs = [
		input.origin,
		input.toolSha,
		`${input.base} ${input.head}`,
		requiredBrowsers(options).join(" "),
	];
	const prepared = await ssh(host, script(BOOTSTRAP, "perf-bootstrap", bootstrapArgs), "bootstrap");
	const [toolDir, cache] = prepared.trim().split("\n").slice(-2);
	if (!toolDir || !cache) throw new Error(`${host}: bootstrap printed no tool dir`);
	const remoteOut = `${cache}/runs/${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`;
	const compareArgs = [
		"bun",
		"run",
		"perf:compare",
		input.base,
		input.head,
		"--host",
		"local",
		"--json-only",
		"--out",
		remoteOut,
		...forwardArgs(options),
	];
	const pidFile = `${remoteOut}/compare.pid`;
	try {
		await ssh(
			host,
			`cd ${shellQuote(toolDir)} && ${script(REMOTE_RUN, "perf-run", [pidFile, ...compareArgs])}`,
			"perf:compare",
			"pipe",
		);
	} catch (error) {
		if (!processRunnerInterruption()) {
			await ssh(
				host,
				`kill -TERM -- "-$(cat ${shellQuote(pidFile)})" 2>/dev/null; true`,
				"stop",
			).catch(() => "");
		}
		throw error;
	}
	const remoteJson = `${remoteOut}/compare.json`;
	const copyBack = () => ssh(host, `cat ${shellQuote(remoteJson)}`, "copy back");
	const json = await copyBack()
		.catch(copyBack)
		.catch((error: unknown) => {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`${reason}; result kept at ${host}:${remoteJson}`);
		});
	await ssh(host, `rm -rf ${shellQuote(remoteOut)}`, "cleanup").catch(() => "");
	return JSON.parse(json) as CompareResult;
}

function withRefs(result: CompareResult, refs: { base: string; head: string }): CompareResult {
	return {
		...result,
		base: { ...result.base, ref: refs.base },
		head: { ...result.head, ref: refs.head },
	};
}

function writeHost(dir: string, result: CompareResult, jsonOnly: boolean) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "compare.json"), `${JSON.stringify(result, null, 2)}\n`);
	if (!jsonOnly) writeFileSync(join(dir, "compare.md"), renderReport(result));
}

export async function runOnHosts(input: {
	toolRoot: string;
	baseRef: string;
	headRef: string;
	hosts: readonly string[];
	options: CompareOptions;
}) {
	const { options } = input;
	const base = resolveSha(input.toolRoot, input.baseRef);
	const head = resolveSha(input.toolRoot, input.headRef);
	const localName = hostname();
	const hosts = [...new Set(input.hosts)];
	const local = (host: string) => isLocalHost({ host, localName, sshHostname: sshHostname(host) });
	const localHosts = hosts.filter(local);
	const remoteHosts = hosts.filter((host) => !localHosts.includes(host));
	const remote = remoteHosts.length > 0 ? remotePreflight(input.toolRoot, { base, head }) : null;
	const refs = { base: input.baseRef, head: input.headRef };
	const runLocal = async ([first, ...aliases]: readonly string[]) => {
		const run = await runCompare({
			toolRoot: input.toolRoot,
			baseRef: input.baseRef,
			headRef: input.headRef,
			options: { ...options, out: join(options.out, first ?? "local") },
		});
		for (const alias of aliases) writeHost(join(options.out, alias), run.result, options.jsonOnly);
		return run.result;
	};
	const runHost = async (host: string) => {
		if (!remote) throw new Error("remote preflight missing");
		const result = withRefs(await runRemote({ host, ...remote, base, head, options }), refs);
		writeHost(join(options.out, host), result, options.jsonOnly);
		return result;
	};
	const tasks = [
		...(localHosts.length > 0 ? [{ hosts: localHosts, run: () => runLocal(localHosts) }] : []),
		...remoteHosts.map((host) => ({ hosts: [host], run: () => runHost(host) })),
	];
	const settled = await Promise.allSettled(tasks.map((task) => task.run()));
	const failures = settled.flatMap((entry, index) =>
		entry.status === "rejected"
			? [
					`${tasks[index]?.hosts.join(", ")}: ${entry.reason instanceof Error ? entry.reason.message : String(entry.reason)}`,
				]
			: [],
	);
	const markdown = settled
		.flatMap((entry) => (entry.status === "fulfilled" ? [renderReport(entry.value)] : []))
		.join("\n---\n\n");
	const markdownPath = options.jsonOnly ? null : join(options.out, "compare.md");
	if (markdownPath && settled.some((entry) => entry.status === "fulfilled"))
		writeFileSync(markdownPath, markdown);
	return { failures, markdown, markdownPath, outDir: options.out };
}
