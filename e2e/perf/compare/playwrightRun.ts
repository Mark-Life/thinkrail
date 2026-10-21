import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runE2eProcess } from "../../processRunner";
import { hermeticEnv } from "./env";
import type { CompareOptions, Env, SuiteContext } from "./types";

const PERF_E2E_LANE = "15";

const PASSTHROUGH = [
	"THINKRAIL_E2E_LANE",
	"THINKRAIL_E2E_PORT_BASE",
	"PLAYWRIGHT_BROWSERS_PATH",
] as const;

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

export function failureReason(log: string, exitCode: number) {
	const lines = log.split("\n").map((line) => line.trim());
	const error = lines.find((line) => /^(Error|TimeoutError|expect\()/.test(line));
	return error
		? `${error} (playwright exit ${exitCode})`
		: `playwright exit ${exitCode}, no output`;
}

export async function runPerfSpec(input: {
	context: SuiteContext;
	spec: string;
	browser: CompareOptions["browser"];
	env: Env;
}) {
	const { context } = input;
	const env = hermeticEnv(join(context.sampleDir, "state"), {
		PLAYWRIGHT_BROWSERS_PATH: defaultBrowsersPath(),
		THINKRAIL_E2E_LANE: PERF_E2E_LANE,
		...passthrough(),
		THINKRAIL_E2E_SKIP_BUILD: "1",
		THINKRAIL_PERF_APP_ROOT: context.appRoot,
		THINKRAIL_PERF_BROWSER: input.browser,
		...input.env,
	});
	const result = await runE2eProcess(
		[process.execPath, "x", "playwright", "test", "-c", "playwright.perf.config.ts", input.spec],
		{ env, stdout: "pipe" },
	);
	writeFileSync(join(context.sampleDir, "playwright.log"), result.stdout);
	return result;
}
