import { bundleSuite } from "./suiteBundle";
import { rendersSuite } from "./suiteRenders";
import { startupSuite } from "./suiteStartup";
import { waterfallSuite } from "./suiteWaterfall";

export const SUITES = [bundleSuite, rendersSuite, startupSuite, waterfallSuite] as const;

export const SUITE_NAMES: readonly string[] = SUITES.map((suite) => suite.name);

export const DEFAULT_SUITE_NAMES: readonly string[] = SUITES.filter((suite) => !suite.optIn).map(
	(suite) => suite.name,
);
