import { bundleSuite } from "./suiteBundle";

export const SUITES = [bundleSuite] as const;

export const SUITE_NAMES: readonly string[] = SUITES.map((suite) => suite.name);
