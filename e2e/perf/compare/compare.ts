import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { prepareSha, resolveSha, toolState } from "./checkout";
import { hermeticWarning, userStateStamp } from "./env";
import { renderReport } from "./report";
import { runSuite } from "./schedule";
import { summarizeMetrics } from "./stats";
import { SUITES } from "./suites";
import type { Artifact, CompareOptions, CompareResult, Sha, Suite, SuiteResult } from "./types";

const PROTOCOL_FILE = "packages/contracts/src/wsProtocol.ts";

export function selectSuites(names: readonly string[]): readonly Suite[] {
	return SUITES.filter((suite) => names.includes(suite.name));
}

export function selectArtifacts(suites: readonly Suite[], platform = process.platform) {
	const byKey = new Map<Artifact["key"], Artifact>();
	for (const artifact of suites.flatMap((suite) => suite.artifacts)) {
		if (artifact.platforms && !artifact.platforms.includes(platform)) continue;
		byKey.set(artifact.key, artifact);
	}
	return [...byKey.values()];
}

export function readProtocolVersion(appRoot: string) {
	const file = join(appRoot, PROTOCOL_FILE);
	if (!existsSync(file)) return null;
	const match = /export const PROTOCOL_VERSION = (\d+);/.exec(readFileSync(file, "utf8"));
	return match?.[1] ? Number(match[1]) : null;
}

export async function prepareRefs(input: {
	toolRoot: string;
	refs: readonly string[];
	options: Pick<CompareOptions, "suites" | "rebuild">;
}) {
	const artifacts = selectArtifacts(selectSuites(input.options.suites));
	const prepared: { ref: string; sha: Sha; appRoot: string }[] = [];
	for (const ref of input.refs) {
		const sha = resolveSha(input.toolRoot, ref);
		const appRoot = await prepareSha({
			toolRoot: input.toolRoot,
			sha,
			artifacts,
			rebuild: input.options.rebuild,
		});
		prepared.push({ ref, sha, appRoot });
	}
	return prepared;
}

function protocolWarnings(base: number | null, head: number | null, suites: readonly Suite[]) {
	if (base === head) return [];
	const browserSuites = suites.filter((suite) => suite.browser).map((suite) => suite.name);
	return [
		`protocol version differs (${base ?? "unknown"} → ${head ?? "unknown"}): the tool's browser harness may not match one side${browserSuites.length > 0 ? `; affects ${browserSuites.join(", ")}` : ""}`,
	];
}

export async function runCompare(input: {
	toolRoot: string;
	baseRef: string;
	headRef: string;
	options: CompareOptions;
}) {
	const { options } = input;
	const suites = selectSuites(options.suites);
	const [base, head] = await prepareRefs({
		toolRoot: input.toolRoot,
		refs: [input.baseRef, input.headRef],
		options,
	});
	if (!base || !head) throw new Error("expected two prepared refs");
	const baseProtocol = readProtocolVersion(base.appRoot);
	const headProtocol = readProtocolVersion(head.appRoot);
	const warnings = protocolWarnings(baseProtocol, headProtocol, suites);
	if (warnings.length > 0 && options.strictProtocol && suites.some((suite) => suite.browser)) {
		throw new Error(`${warnings[0]} (--strict-protocol)`);
	}
	const stamp = userStateStamp();
	mkdirSync(options.out, { recursive: true });
	const results: SuiteResult[] = [];
	for (const suite of suites) {
		const run = await runSuite({
			suite,
			sides: { base, head },
			toolRoot: input.toolRoot,
			options,
			outDir: options.out,
		});
		results.push({
			name: suite.name,
			schedule: suite.schedule(options),
			variants: run.variants,
			metrics: summarizeMetrics({ ...run.samples, threshold: options.threshold }),
			loadavg: run.loadavg,
		});
	}
	const hermetic = hermeticWarning(stamp);
	const busy = results.filter((suite) => suite.loadavg.some((load) => load.load1 > load.cores));
	if (busy.length > 0) {
		warnings.push(`load above 1 per core during ${busy.map((suite) => suite.name).join(", ")}`);
	}
	const result: CompareResult = {
		generatedAt: new Date().toISOString(),
		host: hostname(),
		tool: toolState(input.toolRoot),
		base: { ref: base.ref, sha: base.sha, protocolVersion: baseProtocol },
		head: { ref: head.ref, sha: head.sha, protocolVersion: headProtocol },
		threshold: options.threshold,
		warnings: hermetic ? [...warnings, hermetic] : warnings,
		suites: results,
	};
	const jsonPath = join(options.out, "compare.json");
	writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
	const markdown = renderReport(result);
	const markdownPath = options.jsonOnly ? null : join(options.out, "compare.md");
	if (markdownPath) writeFileSync(markdownPath, markdown);
	return { result, markdown, jsonPath, markdownPath };
}
