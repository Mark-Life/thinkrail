import { mkdirSync, rmSync } from "node:fs";
import { availableParallelism, hostname, loadavg } from "node:os";
import { join } from "node:path";
import { processRunnerInterruption } from "../../processRunner";
import { settled, summarizeMetrics } from "./stats";
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

interface SideTarget {
	sha: Sha;
	appRoot: string;
}

export interface SuiteRunInput {
	suite: Suite;
	sides: Record<Side, SideTarget>;
	options: CompareOptions;
	outDir: string;
}

export interface SuiteRun {
	variants: VariantStatus[];
	samples: Record<Side, Measurement[]>;
	loadavg: LoadSample[];
	warnings: string[];
}

type Collected = Map<string, Record<Side, Measurement[]>>;

const AUTO_PRECISION_PCT = 2;
const MAX_FAILED_ROUNDS = 3;

function roundOrder(round: number): readonly Side[] {
	return round % 2 === 1 ? ["base", "head"] : ["head", "base"];
}

function loadSample(round: number): LoadSample {
	return { round, load1: loadavg()[0] ?? 0, cores: availableParallelism() };
}

async function sampleOnce(
	input: SuiteRunInput,
	side: Side,
	variant: string,
	round: number,
): Promise<SampleResult> {
	const sampleDir = join(input.outDir, "samples", input.suite.name, side, `${variant}-${round}`);
	const context: SuiteContext = {
		side,
		sha: input.sides[side].sha,
		appRoot: input.sides[side].appRoot,
		sampleDir,
		round,
		options: input.options,
	};
	let result: SampleResult;
	try {
		rmSync(sampleDir, { recursive: true, force: true });
		mkdirSync(sampleDir, { recursive: true });
		result = await input.suite.sample(context, variant);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if ((error as NodeJS.ErrnoException).code === "ENOSPC" || message.includes("ENOSPC")) {
			throw new Error(`disk full while sampling into ${sampleDir}: free space and rerun`);
		}
		result = { ok: false, incompatible: message };
	}
	const signal = processRunnerInterruption();
	if (signal) throw new Error(`interrupted by ${signal}`);
	return result;
}

function flatten(collected: Collected, variants: readonly string[] = [...collected.keys()]) {
	const flat = (side: Side) => variants.flatMap((variant) => collected.get(variant)?.[side] ?? []);
	return { base: flat("base"), head: flat("head") };
}

function resolved(collected: Collected, variants: readonly string[], threshold: number) {
	return summarizeMetrics({ ...flatten(collected, variants), threshold }).every((metric) =>
		settled(metric, AUTO_PRECISION_PCT),
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
	const log = (line: string) => console.error(`perf:compare[${hostname()}]: ${suite.name} ${line}`);
	const loads: LoadSample[] = [];
	const warnings: string[] = [];
	const proven = new Set<string>();
	const retired = new Set<string>();
	const failedRounds = new Map<string, number>();
	const active = () => [...collected.keys()].filter((variant) => !retired.has(variant));

	if (schedule.kind !== "once") {
		for (const variant of collected.keys()) {
			for (const side of roundOrder(1)) {
				if (!collected.has(variant)) break;
				log(`warmup ${variant} ${side}`);
				const result = await sampleOnce(input, side, variant, 0);
				if (result.ok) proven.add(`${variant}:${side}`);
				else fail(variant, side, result.incompatible);
			}
		}
	}

	const measure = async (variant: string, side: Side, round: number) => {
		const key = `${variant}:${side}`;
		let result = await sampleOnce(input, side, variant, round);
		if (!result.ok && proven.has(key)) {
			log(`retry ${variant} ${side} round ${round}: ${result.incompatible}`);
			result = await sampleOnce(input, side, variant, round);
		}
		if (result.ok) {
			proven.add(key);
			collected.get(variant)?.[side].push(...result.measurements);
			return;
		}
		if (!proven.has(key)) {
			fail(variant, side, result.incompatible);
			return;
		}
		const failed = (failedRounds.get(variant) ?? 0) + 1;
		failedRounds.set(variant, failed);
		warnings.push(
			`${suite.name} ${variant} ${side}: round ${round} skipped: ${result.incompatible}`,
		);
		if (failed < MAX_FAILED_ROUNDS) return;
		retired.add(variant);
		warnings.push(
			`${suite.name} ${variant}: stopped after ${failed} failed rounds, earlier samples kept`,
		);
	};

	const started = Date.now();
	const done = (round: number) => {
		if (active().length === 0) return true;
		if (schedule.kind === "once") return round >= 1;
		if (schedule.kind === "rounds") return round >= schedule.rounds;
		if (Date.now() - started > schedule.maxMinutes * 60_000) return true;
		if (round < schedule.minRuns || (round - schedule.minRuns) % schedule.batch !== 0) return false;
		return resolved(collected, active(), options.threshold);
	};

	for (let round = 1; !done(round - 1); round += 1) {
		const load = loadSample(round);
		loads.push(load);
		for (const side of roundOrder(round)) {
			for (const variant of active()) {
				log(`round ${round} ${variant} ${side} (load ${load.load1.toFixed(2)})`);
				await measure(variant, side, round);
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
	return {
		variants,
		samples: flatten(collected),
		loadavg: loads,
		warnings,
	};
}
