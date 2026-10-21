import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSuite } from "./schedule";
import type { CompareOptions, SampleResult, Sha, Suite, SuiteContext } from "./types";

const outDir = mkdtempSync(join(tmpdir(), "perf-schedule-test-"));

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const OPTIONS: CompareOptions = {
	suites: ["fake"],
	scenarios: null,
	rounds: 4,
	startup: [],
	minRuns: 2,
	maxMinutes: 1,
	threshold: 0,
	cpu: 1,
	browser: "chromium",
	strictProtocol: false,
	out: outDir,
	rebuild: false,
	jsonOnly: true,
};

function suite(sample: (context: SuiteContext, variant: string) => SampleResult): Suite {
	return {
		name: "fake",
		artifacts: [],
		browser: false,
		schedule: () => ({ kind: "rounds", rounds: 4 }),
		variants: () => ["a", "b"],
		sample: async (context, variant) => sample(context, variant),
	};
}

function ok(variant: string): SampleResult {
	const measurement = {
		id: variant,
		group: "g",
		label: variant,
		unit: "ms",
		kind: "timed",
		better: "lower",
		value: 10,
	} as const;
	return { ok: true, measurements: [measurement] };
}

function run(fake: Suite) {
	const side = { sha: "a".repeat(40) as Sha, appRoot: outDir };
	return runSuite({
		suite: fake,
		sides: { base: side, head: side },
		toolRoot: outDir,
		options: OPTIONS,
		outDir,
	});
}

test("a later failed round is skipped and earlier samples are kept", async () => {
	const result = await run(
		suite((context, variant) =>
			variant === "a" && context.side === "head" && context.round === 2
				? { ok: false, incompatible: "not ready after 60000 ms" }
				: ok(variant),
		),
	);
	expect(result.variants.every((variant) => variant.status === "ok")).toBe(true);
	expect(result.samples.head.filter((m) => m.id === "a")).toHaveLength(3);
	expect(result.samples.base.filter((m) => m.id === "a")).toHaveLength(4);
	expect(result.warnings).toEqual(["fake a head: round 2 skipped: not ready after 60000 ms"]);
});

test("a retry that succeeds leaves no gap", async () => {
	let failures = 0;
	const result = await run(
		suite((context, variant) => {
			if (variant === "a" && context.round === 3 && failures === 0) {
				failures += 1;
				return { ok: false, incompatible: "flake" };
			}
			return ok(variant);
		}),
	);
	expect(result.samples.base.filter((m) => m.id === "a")).toHaveLength(4);
	expect(result.warnings).toEqual([]);
});

test("a warmup failure still excludes the variant", async () => {
	const result = await run(
		suite((context, variant) =>
			variant === "b" && context.side === "base"
				? { ok: false, incompatible: "missing testid" }
				: ok(variant),
		),
	);
	expect(result.variants).toContainEqual({
		name: "b",
		status: "incompatible",
		reason: "base: missing testid",
	});
	expect(result.samples.head.some((m) => m.id === "b")).toBe(false);
});

test("a full disk aborts the suite", async () => {
	const enospc = Object.assign(new Error("ENOSPC: no space left on device, write"), {
		code: "ENOSPC",
	});
	const fake = suite(() => ok("a"));
	fake.sample = async () => {
		throw enospc;
	};
	await expect(run(fake)).rejects.toThrow("disk full");
});
