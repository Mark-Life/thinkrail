import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioRun as RenderRun } from "../render.perf";
import { EMPTY_COST, MARKDOWN_SUBTREE } from "../renderProfiler";
import { DEFAULT_SCENARIOS, isScenarioName, KEY_COMPONENTS, parseScenarios } from "../scenarios";
import { profileWeb } from "./artifacts";
import { failureReason, runPerfSpec } from "./playwrightRun";
import type { Measurement, MetricSummary, SampleResult, Suite, SuiteContext } from "./types";

const DEFAULT_ROUNDS = 5;
const TOP_COMPONENTS = 15;

type ScenarioRun = Pick<RenderRun, "scenario" | "wallMs" | "mainThread" | "profile">;

const trackedComponents = new Map<string, readonly string[]>();

export function selectScenarios(selected: readonly string[] | null): readonly string[] {
	return selected ? parseScenarios(selected) : DEFAULT_SCENARIOS;
}

function timed(input: {
	id: string;
	group: string;
	label: string;
	unit: "ms" | "count";
	value: number;
}): Measurement {
	return { ...input, kind: "timed", better: "lower" };
}

export function scenarioMeasurements(run: ScenarioRun): Measurement[] {
	const { profile, mainThread } = run;
	const markdown = profile.subtrees[MARKDOWN_SUBTREE];
	const rows: (readonly [string, string, "ms" | "count", number])[] = [
		["totalMs", "render total", "ms", profile.totalMs],
		["commits", "commits", "count", profile.commits],
		["maxCommitMs", "max commit", "ms", profile.maxCommitMs],
		["wallMs", "wall", "ms", run.wallMs],
		["longTasks", "long tasks", "count", profile.longTasks.count],
		["longTaskMs", "long task total", "ms", profile.longTasks.totalMs],
		["longTaskMaxMs", "long task max", "ms", profile.longTasks.maxMs],
		["frameGapP95Ms", "frame gap p95", "ms", profile.frames.p95GapMs],
		["frameGapMaxMs", "frame gap max", "ms", profile.frames.maxGapMs],
		["droppedFrames", "dropped frames", "count", profile.frames.droppedFrames],
		["taskMs", "main thread task", "ms", mainThread.taskMs],
		["scriptMs", "main thread script", "ms", mainThread.scriptMs],
		["layoutMs", "main thread layout", "ms", mainThread.layoutMs],
		["styleMs", "main thread style", "ms", mainThread.styleMs],
		...(markdown
			? ([
					["markdownRootRenders", "markdown root renders", "count", markdown.rootRenders],
					["markdownSelfMs", "markdown self", "ms", markdown.selfTotalMs],
				] as const)
			: []),
	];
	return rows.map(([key, label, unit, value]) =>
		timed({ id: `renders/${run.scenario}/${key}`, group: run.scenario, label, unit, value }),
	);
}

export function topComponents(run: ScenarioRun, limit = TOP_COMPONENTS) {
	return Object.entries(run.profile.components)
		.sort(([, a], [, b]) => b.selfTotalMs - a.selfTotalMs)
		.slice(0, limit)
		.map(([name]) => name);
}

export function componentMeasurements(run: ScenarioRun, names: readonly string[]): Measurement[] {
	const group = `${run.scenario} components`;
	return names.flatMap((name) => {
		const cost = run.profile.components[name] ?? EMPTY_COST;
		const id = `renders/${run.scenario}/component/${name}`;
		return [
			timed({
				id: `${id}/selfMs`,
				group,
				label: `${name} self`,
				unit: "ms",
				value: cost.selfTotalMs,
			}),
			timed({
				id: `${id}/commits`,
				group,
				label: `${name} commits`,
				unit: "count",
				value: cost.commits,
			}),
			timed({
				id: `${id}/renders`,
				group,
				label: `${name} renders`,
				unit: "count",
				value: cost.renders,
			}),
		];
	});
}

function countUnchanged(metric: MetricSummary | undefined) {
	if (!metric) return false;
	return (
		metric.verdict === "same" ||
		(metric.verdict === "unsure" && metric.base.median === metric.head.median)
	);
}

export function markTimingOnly(metrics: readonly MetricSummary[]): MetricSummary[] {
	const byId = new Map(metrics.map((metric) => [metric.id, metric]));
	return metrics.map((metric) => {
		const self = /^(renders\/[^/]+\/component\/.+\/)selfMs$/.exec(metric.id);
		if (!self || (metric.verdict !== "better" && metric.verdict !== "worse")) return metric;
		const counts = ["renders", "commits"].map((key) => byId.get(`${self[1]}${key}`));
		return counts.every(countUnchanged) ? { ...metric, timingOnly: true } : metric;
	});
}

export function pinnedComponents(scenario: string) {
	return (isScenarioName(scenario) && KEY_COMPONENTS[scenario]) || [];
}

function componentsFor(context: SuiteContext, run: ScenarioRun) {
	const key = `${context.options.out}\u0000${run.scenario}`;
	const tracked = trackedComponents.get(key);
	if (context.round === 0 || !tracked) {
		const names = [
			...new Set([...pinnedComponents(run.scenario), ...(tracked ?? []), ...topComponents(run)]),
		];
		trackedComponents.set(key, names);
		return names;
	}
	return tracked;
}

async function sample(context: SuiteContext, scenario: string): Promise<SampleResult> {
	const result = await runPerfSpec({
		context,
		spec: "e2e/perf/render.perf.ts",
		browser: "chromium",
		env: {
			THINKRAIL_PERF_RUNS: "1",
			THINKRAIL_PERF_OUT: context.sampleDir,
			THINKRAIL_PERF_SCENARIOS: scenario,
			THINKRAIL_PERF_CPU: String(context.options.cpu),
		},
	});
	const file = join(context.sampleDir, `${scenario}-1.json`);
	if (result.exitCode !== 0 || !existsSync(file)) {
		return { ok: false, incompatible: failureReason(result.stdout, result.exitCode) };
	}
	const run = JSON.parse(readFileSync(file, "utf8")) as ScenarioRun;
	return {
		ok: true,
		measurements: [
			...scenarioMeasurements(run),
			...componentMeasurements(run, componentsFor(context, run)),
		],
	};
}

export const rendersSuite: Suite = {
	name: "renders",
	artifacts: [profileWeb],
	schedule: (options) => ({ kind: "rounds", rounds: options.rounds ?? DEFAULT_ROUNDS }),
	variants: (options) => selectScenarios(options.scenarios),
	sample,
	annotate: markTimingOnly,
};
