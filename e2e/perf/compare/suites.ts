import { bundleSuite } from "./suiteBundle";
import { rendersSuite } from "./suiteRenders";
import { startupSuite } from "./suiteStartup";

export const SUITES = [bundleSuite, rendersSuite, startupSuite] as const;

export const SUITE_NAMES: readonly string[] = SUITES.map((suite) => suite.name);
