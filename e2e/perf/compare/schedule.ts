import { mkdirSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { processRunnerInterruption } from "../../processRunner";
import { summarizeMetrics } from "./stats";
import type {
	CompareOptions,
	LoadSample,
	Measurement,
	SampleResult,
	Sha,
	Side,
	Suite,
	SuiteContext,
	VariantStatus,
} from "./types";

export interface SideTarget {
	sha: Sha;
	appRoot: string;
}

export interface SuiteRunInput {
	suite: Suite;
	sides: Record<Side, SideTarget>;
	toolRoot: string;
	options: CompareOptions;
	outDir: string;
}

export interface SuiteRun {
	variants: VariantStatus[];
	samples: Record<Side, Measurement[]>;
	loadavg: LoadSample[];
}

type Collected = Map<string, Record<Side, Measurement[]>>;

export function roundOrder(round: number): readonly Side[] {
	return round % 2 === 1 ? ["base", "head"] : ["head", "base"];
}

export function loadSample(round: number): LoadSample {
	return { round, load1: loadavg()[0] ?? 0, cores: availableParallelism() };
}

async function sampleOnce(
	input: SuiteRunInput,
	side: Side,
	variant: string,
	round: number,
): Promise<SampleResult> {
	const sampleDir = join(input.outDir, "samples", input.suite.name, side, `${variant}-${round}`);
	mkdirSync(sampleDir, { recursive: true });
	const context: SuiteContext = {
		side,
		sha: input.sides[side].sha,
		appRoot: input.sides[side].appRoot,
		toolRoot: input.toolRoot,
		sampleDir,
		round,
		options: input.options,
	};
	let result: SampleResult;
	try {
		result = await input.suite.sample(context, variant);
	} catch (error) {
		result = { ok: false, incompatible: error instanceof Error ? error.message : String(error) };
	}
	const signal = processRunnerInterruption();
	if (signal) throw new Error(`interrupted by ${signal}`);
	return result;
}

function resolved(collected: Collected, threshold: number) {
	const flat = (side: Side) => [...collected.values()].flatMap((sides) => sides[side]);
	return summarizeMetrics({ base: flat("base"), head: flat("head"), threshold }).every(
		(metric) => metric.kind === "exact" || metric.verdict !== "unsure",
	);
}

export async function runSuite(input: SuiteRunInput): Promise<SuiteRun> {
	const { suite, options } = input;
	const schedule = suite.schedule(options);
	const incompatible = new Map<string, string>();
	const collected: Collected = new Map(
		suite.variants(options).map((variant) => [variant, { base: [], head: [] }]),
	);
	const fail = (variant: string, side: Side, reason: string) => {
		incompatible.set(variant, `${side}: ${reason}`);
		collected.delete(variant);
	};
	const log = (line: string) => console.error(`perf:compare: ${suite.name} ${line}`);
	const loads: LoadSample[] = [];

	if (schedule.kind !== "once") {
		for (const variant of collected.keys()) {
			for (const side of roundOrder(1)) {
				if (!collected.has(variant)) break;
				log(`warmup ${variant} ${side}`);
				const result = await sampleOnce(input, side, variant, 0);
				if (!result.ok) fail(variant, side, result.incompatible);
			}
		}
	}

	const started = Date.now();
	const done = (round: number) => {
		if (collected.size === 0) return true;
		if (schedule.kind === "once") return round >= 1;
		if (schedule.kind === "rounds") return round >= schedule.rounds;
		if (Date.now() - started > schedule.maxMinutes * 60_000) return true;
		if (round < schedule.minRuns || (round - schedule.minRuns) % schedule.batch !== 0) return false;
		return resolved(collected, options.threshold);
	};

	for (let round = 1; !done(round - 1); round += 1) {
		const load = loadSample(round);
		loads.push(load);
		for (const side of roundOrder(round)) {
			for (const variant of [...collected.keys()]) {
				log(`round ${round} ${variant} ${side} (load ${load.load1.toFixed(2)})`);
				const result = await sampleOnce(input, side, variant, round);
				if (!result.ok) {
					fail(variant, side, result.incompatible);
					continue;
				}
				collected.get(variant)?.[side].push(...result.measurements);
			}
		}
	}

	const variants: VariantStatus[] = suite.variants(options).map((name) => {
		const reason = incompatible.get(name);
		return reason === undefined ? { name, status: "ok" } : { name, status: "incompatible", reason };
	});
	if (collected.size === 0) {
		const reasons = variants.map((v) => (v.status === "ok" ? v.name : `${v.name}: ${v.reason}`));
		throw new Error(`${suite.name}: every variant failed (${reasons.join("; ")})`);
	}
	const flat = (side: Side) => [...collected.values()].flatMap((sides) => sides[side]);
	return { variants, samples: { base: flat("base"), head: flat("head") }, loadavg: loads };
}
