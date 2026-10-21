import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { processRunnerInterruption } from "../../processRunner";
import { prepareSha, releaseSha, resolveSha, toolState } from "./checkout";
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

function suiteArtifacts(suite: Suite, options: CompareOptions) {
	const declared =
		typeof suite.artifacts === "function" ? suite.artifacts(options) : suite.artifacts;
	return declared.filter(
		(artifact) => !artifact.platforms || artifact.platforms.includes(process.platform),
	);
}

function selectArtifacts(suites: readonly Suite[], options: CompareOptions) {
	const byKey = new Map<Artifact["key"], Artifact>();
	for (const artifact of suites.flatMap((suite) => suiteArtifacts(suite, options))) {
		byKey.set(artifact.key, artifact);
	}
	return [...byKey.values()];
}

function readProtocolVersion(appRoot: string) {
	const file = join(appRoot, PROTOCOL_FILE);
	if (!existsSync(file)) return null;
	const match = /export const PROTOCOL_VERSION = (\d+);/.exec(readFileSync(file, "utf8"));
	return match?.[1] ? Number(match[1]) : null;
}

export async function prepareRefs(input: {
	toolRoot: string;
	refs: readonly string[];
	options: CompareOptions;
}) {
	const artifacts = selectArtifacts(selectSuites(input.options.suites), input.options);
	const prepared: ({ ref: string; sha: Sha } & Awaited<ReturnType<typeof prepareSha>>)[] = [];
	for (const ref of input.refs) {
		const sha = resolveSha(input.toolRoot, ref);
		const built = await prepareSha({
			toolRoot: input.toolRoot,
			sha,
			artifacts,
			rebuild: input.options.rebuild,
		});
		prepared.push({ ref, sha, ...built });
	}
	return prepared;
}

function buildFailure(
	suite: Suite,
	options: CompareOptions,
	sides: readonly Awaited<ReturnType<typeof prepareRefs>>[number][],
) {
	for (const artifact of suiteArtifacts(suite, options)) {
		for (const side of sides) {
			const reason = side.failed.get(artifact.key);
			if (reason !== undefined) return `${side.ref}: ${artifact.key} build failed: ${reason}`;
		}
	}
	return null;
}

function failedSuite(suite: Suite, options: CompareOptions, reason: string): SuiteResult {
	return {
		name: suite.name,
		schedule: suite.schedule(options),
		variants: suite
			.variants(options)
			.map((name) => ({ name, status: "incompatible" as const, reason })),
		metrics: [],
		loadavg: [],
	};
}

function isFatal(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return processRunnerInterruption() !== null || message.startsWith("disk full");
}

function protocolWarnings(base: number | null, head: number | null) {
	if (base === head) return [];
	return [
		`protocol version differs (${base ?? "unknown"} → ${head ?? "unknown"}): the tool's browser harness may not match one side`,
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
	try {
		const baseProtocol = readProtocolVersion(base.appRoot);
		const headProtocol = readProtocolVersion(head.appRoot);
		const warnings = protocolWarnings(baseProtocol, headProtocol);
		const stamp = userStateStamp();
		mkdirSync(options.out, { recursive: true });
		const results: SuiteResult[] = [];
		for (const suite of suites) {
			const unbuilt = buildFailure(suite, options, [base, head]);
			if (unbuilt) {
				results.push(failedSuite(suite, options, unbuilt));
				warnings.push(`${suite.name} skipped: ${unbuilt}`);
				continue;
			}
			let run: Awaited<ReturnType<typeof runSuite>>;
			try {
				run = await runSuite({ suite, sides: { base, head }, options, outDir: options.out });
			} catch (error) {
				if (isFatal(error)) throw error;
				const reason = error instanceof Error ? error.message : String(error);
				results.push(failedSuite(suite, options, reason));
				warnings.push(`${suite.name} skipped: ${reason}`);
				continue;
			}
			results.push({
				name: suite.name,
				schedule: suite.schedule(options),
				variants: run.variants,
				metrics: summarizeMetrics({ ...run.samples, threshold: options.threshold }),
				loadavg: run.loadavg,
			});
			warnings.push(...run.warnings);
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
		const markdown = renderReport(result);
		const markdownPath = join(options.out, "compare.md");
		writeFileSync(join(options.out, "compare.json"), `${JSON.stringify(result, null, 2)}\n`);
		writeFileSync(markdownPath, markdown);
		return { result, markdown, markdownPath };
	} finally {
		releaseSha(base.sha);
		releaseSha(head.sha);
	}
}
