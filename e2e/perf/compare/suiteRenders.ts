import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runE2eProcess } from "../../processRunner";
import {
	type ComponentCost,
	MARKDOWN_SUBTREE,
	type MainThreadCost,
	type RenderProfile,
} from "../renderProfiler";
import { DEFAULT_SCENARIOS, isScenarioName, SCENARIO_NAMES } from "../scenarios";
import { profileWeb } from "./artifacts";
import { hermeticEnv } from "./env";
import type { Env, Measurement, SampleResult, Suite, SuiteContext } from "./types";

const DEFAULT_ROUNDS = 5;
const TOP_COMPONENTS = 15;
const PASSTHROUGH = [
	"THINKRAIL_E2E_LANE",
	"THINKRAIL_E2E_PORT_BASE",
	"PLAYWRIGHT_BROWSERS_PATH",
] as const;

const EMPTY_COST: ComponentCost = {
	commits: 0,
	renders: 0,
	selfTotalMs: 0,
	selfMaxMs: 0,
	inclusiveTotalMs: 0,
	inclusiveMaxMs: 0,
};

interface ScenarioRun {
	scenario: string;
	wallMs: number;
	mainThread: MainThreadCost;
	profile: RenderProfile;
}

const trackedComponents = new Map<string, readonly string[]>();

function defaultBrowsersPath() {
	if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "ms-playwright");
	if (process.platform === "win32") return join(homedir(), "AppData", "Local", "ms-playwright");
	return join(homedir(), ".cache", "ms-playwright");
}

function passthrough(): Env {
	return Object.fromEntries(
		PASSTHROUGH.flatMap((name) => {
			const value = process.env[name];
			return value ? [[name, value]] : [];
		}),
	);
}

export function selectScenarios(selected: readonly string[] | null): readonly string[] {
	if (!selected) return DEFAULT_SCENARIOS;
	const unknown = selected.filter((name) => !isScenarioName(name));
	if (unknown.length > 0) {
		throw new Error(
			`unknown scenario: ${unknown.join(", ")} (known: ${SCENARIO_NAMES.join(", ")})`,
		);
	}
	return selected;
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

function componentsFor(context: SuiteContext, run: ScenarioRun) {
	const key = `${context.options.out}\u0000${run.scenario}`;
	const tracked = trackedComponents.get(key);
	if (context.round === 0 || !tracked) {
		const names = [...new Set([...(tracked ?? []), ...topComponents(run)])];
		trackedComponents.set(key, names);
		return names;
	}
	return tracked;
}

function failureReason(log: string, exitCode: number) {
	const lines = log.split("\n").map((line) => line.trim());
	const error = lines.find((line) => /^(Error|TimeoutError|expect\()/.test(line));
	return error
		? `${error} (playwright exit ${exitCode})`
		: `playwright exit ${exitCode}, no output`;
}

async function sample(context: SuiteContext, scenario: string): Promise<SampleResult> {
	const env = hermeticEnv(join(context.sampleDir, "state"), {
		PLAYWRIGHT_BROWSERS_PATH: defaultBrowsersPath(),
		...passthrough(),
		THINKRAIL_E2E_SKIP_BUILD: "1",
		THINKRAIL_PERF_APP_ROOT: context.appRoot,
		THINKRAIL_PERF_BROWSER: "chromium",
		THINKRAIL_PERF_RUNS: "1",
		THINKRAIL_PERF_OUT: context.sampleDir,
		THINKRAIL_PERF_SCENARIOS: scenario,
		THINKRAIL_PERF_CPU: String(context.options.cpu),
	});
	const result = await runE2eProcess(
		[
			process.execPath,
			"x",
			"playwright",
			"test",
			"-c",
			"playwright.perf.config.ts",
			"e2e/perf/render.perf.ts",
		],
		{ env, stdout: "pipe" },
	);
	writeFileSync(join(context.sampleDir, "playwright.log"), result.stdout);
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

export const rendersSuite: Suite<"renders"> = {
	name: "renders",
	artifacts: [profileWeb],
	browser: true,
	schedule: (options) => ({ kind: "rounds", rounds: options.rounds ?? DEFAULT_ROUNDS }),
	variants: (options) => selectScenarios(options.scenarios),
	sample,
};
