import { bundleSuite } from "./suiteBundle";
import { rendersSuite } from "./suiteRenders";

export const SUITES = [bundleSuite, rendersSuite] as const;

export const SUITE_NAMES: readonly string[] = SUITES.map((suite) => suite.name);
