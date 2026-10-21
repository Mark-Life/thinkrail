import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { locateDesktopLauncher } from "@thinkrail/artifact-tests";
import { binary, desktop } from "./artifacts";
import { hermeticEnv } from "./env";
import { freePort, type Launch, prepareHome, timeToExit, timeToReady } from "./startupProcess";
import type { CompareOptions, Env, Measurement, SampleResult, Suite, SuiteContext } from "./types";

const STARTUP_KINDS = ["cli", "server", "binary", "desktop"] as const;
type StartupKind = (typeof STARTUP_KINDS)[number];
type Cache = "cold" | "warm";

const AUTO_BATCH = 5;
const VERSION_TIMEOUT_MS = 30_000;
const SERVE_TIMEOUT_MS = 60_000;
const READY_LINE = /thinkrail → http:\/\/[^\s:]+:(\d+)/;
const BINARY_NAME = process.platform === "win32" ? "thinkrail.exe" : "thinkrail";

function isKind(value: string): value is StartupKind {
	return (STARTUP_KINDS as readonly string[]).includes(value);
}

export function startupKinds(options: Pick<CompareOptions, "startup">) {
	const unknown = options.startup.filter((kind) => !isKind(kind));
	if (unknown.length > 0) {
		throw new Error(
			`--startup: unknown ${unknown.join(", ")} (known: ${STARTUP_KINDS.join(", ")})`,
		);
	}
	return options.startup.filter(isKind);
}

function ms(input: { id: string; group: string; label: string; value: number }): Measurement {
	return { ...input, unit: "ms", kind: "timed", better: "lower" };
}

interface SampleState {
	cwd: string;
	env: Env;
}

function sampleState(
	context: SuiteContext,
	cache: Cache,
	extra: (shaDir: string) => Env,
	slot: string = cache,
) {
	const stateDir = join(context.sampleDir, slot);
	const shaDir = join(context.options.out, "state", "startup", context.sha);
	const env = hermeticEnv(stateDir, {
		BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(cache === "warm" ? shaDir : stateDir, "transpiler"),
		...(cache === "warm" ? extra(shaDir) : {}),
	});
	const cwd = join(stateDir, "cwd");
	mkdirSync(cwd, { recursive: true });
	prepareHome(env.HOME ?? join(stateDir, "home"));
	return { cwd, env } satisfies SampleState;
}

function serverArgs(port: number) {
	return ["--port", String(port), "--host", "127.0.0.1", "--no-open", "--no-analytics"];
}

async function serveRows(launch: Launch, group: string, prefix: string, label: string) {
	const port = await freePort();
	const times = await timeToReady(
		{ ...launch, command: [...launch.command, ...serverArgs(port)] },
		{ stdout: READY_LINE, health: port },
		SERVE_TIMEOUT_MS,
	);
	if (times.stdout === undefined || times.health === undefined) {
		throw new Error(`${label}: no ready line or /health`);
	}
	return [
		ms({ id: `${prefix}/url`, group, label: `${label}: spawn to URL line`, value: times.stdout }),
		ms({ id: `${prefix}/health`, group, label: `${label}: spawn to /health`, value: times.health }),
	];
}

async function sampleCli(context: SuiteContext) {
	const entry = join(context.appRoot, "apps/cli/src/index.ts");
	const rows: Measurement[] = [];
	for (const cache of ["cold", "warm"] as const) {
		const state = sampleState(context, cache, () => ({}));
		const value = await timeToExit(
			{ ...state, command: [process.execPath, entry, "--version"] },
			VERSION_TIMEOUT_MS,
		);
		rows.push(
			ms({
				id: `startup/cli/version-${cache}`,
				group: "cli",
				label: `source --version (${cache} transpiler cache)`,
				value,
			}),
		);
	}
	return rows;
}

async function sampleServer(context: SuiteContext) {
	const entry = join(context.appRoot, "apps/cli/src/index.ts");
	const rows: Measurement[] = [];
	for (const cache of ["cold", "warm"] as const) {
		const state = sampleState(context, cache, () => ({}));
		const launch = { ...state, command: [process.execPath, entry] };
		rows.push(
			...(await serveRows(launch, "server", `startup/server/${cache}`, `source server (${cache})`)),
		);
	}
	return rows;
}

async function sampleBinary(context: SuiteContext) {
	const executable = join(context.appRoot, "apps/cli/dist", BINARY_NAME);
	const rows: Measurement[] = [];
	for (const cache of ["cold", "warm"] as const) {
		const stagingCache = (shaDir: string) => ({ XDG_CACHE_HOME: join(shaDir, "xdg-cache") });
		const version = sampleState(context, cache, stagingCache);
		const value = await timeToExit(
			{ ...version, command: [executable, "--version"] },
			VERSION_TIMEOUT_MS,
		);
		rows.push(
			ms({
				id: `startup/binary/${cache}/version`,
				group: "binary",
				label: `binary --version (${cache} staging cache)`,
				value,
			}),
		);
		const serve = sampleState(context, cache, stagingCache, `${cache}-serve`);
		const launch = { ...serve, command: [executable] };
		rows.push(
			...(await serveRows(launch, "binary", `startup/binary/${cache}`, `binary server (${cache})`)),
		);
	}
	return rows;
}

async function sampleDesktop(context: SuiteContext) {
	if (process.platform !== "darwin") throw new Error("desktop startup is macOS only");
	const launcher = locateDesktopLauncher(join(context.appRoot, "apps/desktop"));
	const state = sampleState(context, "cold", () => ({}));
	const readyFile = join(context.sampleDir, "desktop.ready.json");
	const env = {
		...state.env,
		THINKRAIL_DESKTOP_READY_FILE: readyFile,
		THINKRAIL_DESKTOP_USER_DATA: join(context.sampleDir, "desktop-user-data"),
		THINKRAIL_DESKTOP_HIDDEN: "1",
	};
	const times = await timeToReady(
		{ ...state, env, command: [launcher] },
		{ file: readyFile },
		SERVE_TIMEOUT_MS,
	);
	if (times.file === undefined) throw new Error("desktop: no ready file");
	return [
		ms({
			id: "startup/desktop/dom-ready",
			group: "desktop",
			label: "desktop: spawn to dom-ready",
			value: times.file,
		}),
	];
}

const SAMPLERS: Record<StartupKind, (context: SuiteContext) => Promise<Measurement[]>> = {
	cli: sampleCli,
	server: sampleServer,
	binary: sampleBinary,
	desktop: sampleDesktop,
};

export const startupSuite: Suite<"startup"> = {
	name: "startup",
	artifacts: (options) => {
		const kinds = startupKinds(options);
		return [
			...(kinds.includes("binary") ? [binary] : []),
			...(kinds.includes("desktop") ? [desktop] : []),
		];
	},
	browser: false,
	schedule: (options) => ({
		kind: "auto",
		minRuns: options.minRuns,
		batch: AUTO_BATCH,
		maxMinutes: options.maxMinutes,
	}),
	variants: startupKinds,
	async sample(context, variant): Promise<SampleResult> {
		if (!isKind(variant)) return { ok: false, incompatible: `unknown startup kind ${variant}` };
		return { ok: true, measurements: await SAMPLERS[variant](context) };
	},
};
