import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { E2E_ROOT_DIR, processRunnerInterruption, signalExitCode } from "../../processRunner";
import { cacheRoot, cleanAll, cleanSha, resolveSha } from "./checkout";
import { prepareRefs, runCompare } from "./compare";
import { HOSTS, type Host, runOnHosts } from "./remote";
import { renderReport } from "./report";
import { DEFAULT_SUITE_NAMES, SUITE_NAMES } from "./suites";
import type { CompareOptions, CompareResult } from "./types";

const HELP = `perf:compare: compare app performance between two commits

Usage:
  bun run perf:compare <base> <head> [flags]
  bun run perf:compare prepare <ref...> [--suite ...] [--rebuild]
  bun run perf:compare report <compare.json>
  bun run perf:compare clean (--all | <ref>)

Flags:
  --suite a,b          suites to run (known: ${SUITE_NAMES.join(", ")};
                       default ${DEFAULT_SUITE_NAMES.join(", ")})
  --scenario a,b       scenarios for browser suites
  --rounds N           fixed rounds (renders 5, waterfall 7)
  --startup a,b        startup variants (cli, server, binary, desktop)
  --min-runs N         auto-stop minimum runs per side (default 10)
  --max-minutes N      auto-stop time cap (default 3)
  --threshold P        percent change treated as noise (default 0)
  --cpu N              CPU throttling rate for browser suites (default 1)
  --browser NAME       chromium (default) or webkit (waterfall only; renders stay chromium)
  --host NAME          where to run: ${HOSTS.join(", ")}; repeatable, hosts run in
                       parallel. A remote host needs a clean, pushed tool commit and
                       base/head on origin; its result lands in <out>/<host>/
  --strict-protocol    abort browser suites when protocol versions differ
  --out DIR            output directory (default $TMPDIR/thinkrail-perf-compare/<time>)
  --rebuild            ignore build markers and rebuild artifacts
  --json-only          write compare.json only, print no markdown

Cache: ${cacheRoot()} (override with THINKRAIL_PERF_CACHE)`;

type Command =
	| { kind: "help" }
	| { kind: "run"; base: string; head: string; hosts: readonly Host[]; options: CompareOptions }
	| { kind: "prepare"; refs: string[]; options: CompareOptions }
	| { kind: "report"; file: string }
	| { kind: "clean"; target: { all: true } | { ref: string } };

function list(value: string | undefined, flag: string) {
	const items = (value ?? "").split(",").filter(Boolean);
	if (items.length === 0) throw new Error(`${flag} needs a comma-separated list`);
	return items;
}

function number(value: string | undefined, flag: string, min: number) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < min) throw new Error(`${flag} needs a number >= ${min}`);
	return parsed;
}

function defaultOptions(): CompareOptions {
	const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\..+$/, "");
	return {
		suites: DEFAULT_SUITE_NAMES,
		scenarios: null,
		rounds: null,
		startup: ["cli", "server"],
		minRuns: 10,
		maxMinutes: 3,
		threshold: 0,
		cpu: 1,
		browser: "chromium",
		strictProtocol: false,
		out: join(tmpdir(), "thinkrail-perf-compare", stamp),
		rebuild: false,
		jsonOnly: false,
	};
}

export function parseArgs(argv: readonly string[]): Command {
	const options = defaultOptions();
	const positional: string[] = [];
	const hosts: Host[] = [];
	let all = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		const next = () => argv[++index];
		if (arg === "--help" || arg === "-h") return { kind: "help" };
		else if (arg === "--suite") {
			options.suites = list(next(), arg);
			const unknown = options.suites.filter((name) => !SUITE_NAMES.includes(name));
			if (unknown.length > 0) {
				throw new Error(`unknown suite: ${unknown.join(", ")} (known: ${SUITE_NAMES.join(", ")})`);
			}
		} else if (arg === "--scenario") options.scenarios = list(next(), arg);
		else if (arg === "--startup") options.startup = list(next(), arg);
		else if (arg === "--rounds") options.rounds = Math.floor(number(next(), arg, 1));
		else if (arg === "--min-runs") options.minRuns = Math.floor(number(next(), arg, 2));
		else if (arg === "--max-minutes") options.maxMinutes = number(next(), arg, 0.1);
		else if (arg === "--threshold") options.threshold = number(next(), arg, 0);
		else if (arg === "--cpu") options.cpu = number(next(), arg, 1);
		else if (arg === "--browser") {
			const browser = next();
			if (browser !== "chromium" && browser !== "webkit")
				throw new Error("--browser: chromium|webkit");
			options.browser = browser;
		} else if (arg === "--host") {
			const host = HOSTS.find((name) => name === next());
			if (!host) throw new Error(`--host needs one of ${HOSTS.join(", ")}`);
			hosts.push(host);
		} else if (arg === "--strict-protocol") options.strictProtocol = true;
		else if (arg === "--out") options.out = resolve(next() ?? "");
		else if (arg === "--rebuild") options.rebuild = true;
		else if (arg === "--json-only") options.jsonOnly = true;
		else if (arg === "--all") all = true;
		else if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`);
		else positional.push(arg);
	}
	const [first, ...rest] = positional;
	if (first === undefined) return { kind: "help" };
	const remoteHosts = hosts.some((host) => host !== "local");
	if (remoteHosts && ["prepare", "report", "clean"].includes(first)) {
		throw new Error(`--host applies to compare runs only, not ${first}`);
	}
	if (first === "prepare") {
		if (rest.length === 0) throw new Error("prepare needs at least one ref");
		return { kind: "prepare", refs: rest, options };
	}
	if (first === "report") {
		if (rest.length !== 1 || !rest[0]) throw new Error("report needs one compare.json path");
		return { kind: "report", file: rest[0] };
	}
	if (first === "clean") {
		if (all && rest.length === 0) return { kind: "clean", target: { all: true } };
		if (!all && rest.length === 1 && rest[0]) return { kind: "clean", target: { ref: rest[0] } };
		throw new Error("clean needs --all or one ref");
	}
	if (positional.length !== 2 || !rest[0]) throw new Error("expected <base> <head>");
	return {
		kind: "run",
		base: first,
		head: rest[0],
		hosts: hosts.length > 0 ? hosts : ["local"],
		options,
	};
}

async function main(argv: readonly string[]) {
	const command = parseArgs(argv);
	if (command.kind === "help") {
		console.log(HELP);
		return 0;
	}
	if (command.kind === "report") {
		const result = JSON.parse(readFileSync(command.file, "utf8")) as CompareResult;
		process.stdout.write(renderReport(result));
		return 0;
	}
	if (command.kind === "clean") {
		const removed =
			"all" in command.target ? cleanAll() : cleanSha(resolveSha(E2E_ROOT_DIR, command.target.ref));
		console.log(`perf:compare: removed ${removed}`);
		return 0;
	}
	if (command.kind === "prepare") {
		const prepared = await prepareRefs({
			toolRoot: E2E_ROOT_DIR,
			refs: command.refs,
			options: command.options,
		});
		for (const side of prepared) console.log(`${side.ref} ${side.sha} ${side.appRoot}`);
		return 0;
	}
	if (command.hosts.length > 1 || command.hosts[0] !== "local") {
		const run = await runOnHosts({
			toolRoot: E2E_ROOT_DIR,
			baseRef: command.base,
			headRef: command.head,
			hosts: command.hosts,
			options: command.options,
		});
		if (!command.options.jsonOnly) process.stdout.write(run.markdown);
		console.error(`perf:compare: wrote ${run.markdownPath ?? run.outDir}`);
		for (const failure of run.failures) console.error(`perf:compare: ${failure}`);
		return run.failures.length > 0 ? 1 : 0;
	}
	const run = await runCompare({
		toolRoot: E2E_ROOT_DIR,
		baseRef: command.base,
		headRef: command.head,
		options: command.options,
	});
	if (!command.options.jsonOnly) process.stdout.write(run.markdown);
	console.error(`perf:compare: wrote ${run.markdownPath ?? run.jsonPath}`);
	return 0;
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	const signal = processRunnerInterruption();
	if (signal) process.exitCode = signalExitCode(signal);
	else {
		console.error(`perf:compare: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
