import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { runE2eProcess } from "../../processRunner";
import { git, resolveSha, toolState } from "./checkout";
import { runCompare, selectSuites } from "./compare";
import { renderReport } from "./report";
import type { CompareOptions, CompareResult, Sha } from "./types";

export const HOSTS = ["local", "rs8000", "studio"] as const;
export type Host = (typeof HOSTS)[number];

const BOOTSTRAP = readFileSync(new URL("./bootstrap.sh", import.meta.url), "utf8");
const SSH_OPTIONS = ["-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=30"];

export function shellQuote(value: string) {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function normalizeHost(name: string) {
	const lower = name.toLowerCase().replace(/\.$/, "");
	return /^[\d.]+$/.test(lower) ? lower : (lower.split(".")[0] ?? lower);
}

function sshHostname(host: string) {
	try {
		const config = execFileSync("ssh", ["-G", host], { encoding: "utf8" });
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

export function remotePreflight(toolRoot: string, shas: Record<string, Sha>) {
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

async function ssh(host: string, command: string, label: string) {
	const result = await runE2eProcess(["ssh", ...SSH_OPTIONS, host, command], { stdout: "pipe" });
	if (result.exitCode !== 0) throw new Error(`${host}: ${label} failed (exit ${result.exitCode})`);
	return result.stdout;
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
	const prepared = await ssh(
		host,
		`bash -c ${shellQuote(BOOTSTRAP)} perf-bootstrap ${bootstrapArgs.map(shellQuote).join(" ")}`,
		"bootstrap",
	);
	const [toolDir, cache] = prepared.trim().split("\n").slice(-2);
	if (!toolDir || !cache) throw new Error(`${host}: bootstrap printed no tool dir`);
	const remoteOut = `${cache}/runs/${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`;
	const compareArgs = [
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
	await ssh(
		host,
		`cd ${shellQuote(toolDir)} && bun ${compareArgs.map(shellQuote).join(" ")}`,
		"perf:compare",
	);
	const json = await ssh(host, `cat ${shellQuote(`${remoteOut}/compare.json`)}`, "copy back");
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
	hosts: readonly Host[];
	options: CompareOptions;
}) {
	const { options } = input;
	const base = resolveSha(input.toolRoot, input.baseRef);
	const head = resolveSha(input.toolRoot, input.headRef);
	const localName = hostname();
	const plans = [...new Set(input.hosts)].map((host) => ({
		host,
		local: isLocalHost({ host, localName, sshHostname: sshHostname(host) }),
	}));
	const remote = plans.some((plan) => !plan.local)
		? remotePreflight(input.toolRoot, { base, head })
		: null;
	const settled = await Promise.allSettled(
		plans.map(async (plan) => {
			const out = join(options.out, plan.host);
			if (plan.local) {
				const run = await runCompare({
					toolRoot: input.toolRoot,
					baseRef: input.baseRef,
					headRef: input.headRef,
					options: { ...options, out },
				});
				return { host: plan.host, result: run.result };
			}
			if (!remote) throw new Error("remote preflight missing");
			const result = withRefs(
				await runRemote({ host: plan.host, ...remote, base, head, options }),
				{ base: input.baseRef, head: input.headRef },
			);
			writeHost(out, result, options.jsonOnly);
			return { host: plan.host, result };
		}),
	);
	const results = settled.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
	const failures = settled.flatMap((entry, index) =>
		entry.status === "rejected"
			? [
					`${plans[index]?.host}: ${entry.reason instanceof Error ? entry.reason.message : String(entry.reason)}`,
				]
			: [],
	);
	const markdown = results.map((entry) => renderReport(entry.result)).join("\n---\n\n");
	const markdownPath = options.jsonOnly ? null : join(options.out, "compare.md");
	if (markdownPath && results.length > 0) writeFileSync(markdownPath, markdown);
	return { results, failures, markdown, markdownPath, outDir: options.out };
}
