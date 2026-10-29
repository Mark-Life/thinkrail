import { describe, expect, test } from "bun:test";
import { median, spreadPct } from "../stats";
import {
	differenceCi,
	exactVerdict,
	relativeDifferenceCi,
	settled,
	summarizeMetrics,
	tCritical95,
	timedVerdict,
	variance,
} from "./stats";
import type { Measurement } from "./types";

function timed(id: string, value: number): Measurement {
	return { id, group: "g", label: id, unit: "ms", kind: "timed", better: "lower", value };
}

describe("descriptive stats", () => {
	test("median, sample variance and spread", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
		expect(variance([10, 12, 14])).toBe(4);
		expect(spreadPct([10, 12, 14])).toBeCloseTo(33.333, 3);
	});

	test("t table floors fractional df and falls back to the normal value", () => {
		expect(tCritical95(1)).toBe(12.706);
		expect(tCritical95(3.43)).toBe(3.182);
		expect(tCritical95(30)).toBe(2.042);
		expect(tCritical95(31)).toBe(1.96);
	});
});

describe("relativeDifferenceCi", () => {
	test("matches a hand-computed Welch delta-method interval", () => {
		const ci = relativeDifferenceCi([10, 12, 14], [15, 15, 18]);
		expect(ci?.low).toBeCloseTo(-15.35, 1);
		expect(ci?.high).toBeCloseTo(82.01, 1);
	});

	test("needs two samples per side", () => {
		expect(relativeDifferenceCi([1], [1, 2])).toBeNull();
	});

	test("all-zero sides are the same, one zero side has no ratio", () => {
		expect(relativeDifferenceCi([0, 0], [0, 0])).toEqual({ low: 0, high: 0 });
		expect(relativeDifferenceCi([0, 0], [0, 1])).toBeNull();
	});

	test("zero variance collapses to the point estimate", () => {
		const ci = relativeDifferenceCi([10, 10], [12, 12]);
		expect(ci?.low).toBeCloseTo(20, 9);
		expect(ci?.high).toBeCloseTo(20, 9);
	});
});

describe("differenceCi", () => {
	test("matches a hand-computed Welch interval on the difference of means", () => {
		// d = 4, se² = 3/3 + 4/3 = 7/3, df = (7/3)² / (1²/2 + (4/3)²/2) ≈ 3.92 → t(3) = 3.182
		const ci = differenceCi([10, 12, 14], [15, 15, 18]);
		expect(ci?.low).toBeCloseTo(4 - 3.182 * Math.sqrt(7 / 3), 9);
		expect(ci?.high).toBeCloseTo(4 + 3.182 * Math.sqrt(7 / 3), 9);
	});

	test("signed offsets keep their sign", () => {
		const summary = summarizeMetrics({
			base: [0.1, 0.2, 0.1].map((value) => ({ ...timed("o", value), kind: "offset" as const })),
			head: [-40, -50, -45].map((value) => ({ ...timed("o", value), kind: "offset" as const })),
			threshold: 0,
		})[0];
		expect(summary?.verdict).toBe("better");
		expect(summary?.ci?.high).toBeLessThan(0);
	});
});

describe("verdicts", () => {
	test("timed verdict follows the interval and direction", () => {
		const lower = { better: "lower", threshold: 0 } as const;
		expect(timedVerdict({ ...lower, ci: { low: -20, high: -5 } })).toBe("better");
		expect(timedVerdict({ ...lower, ci: { low: 5, high: 20 } })).toBe("worse");
		expect(timedVerdict({ ...lower, ci: { low: -5, high: 5 } })).toBe("unsure");
		expect(timedVerdict({ ...lower, threshold: 10, ci: { low: -5, high: 5 } })).toBe("same");
		expect(timedVerdict({ better: "higher", threshold: 0, ci: { low: 5, high: 20 } })).toBe(
			"better",
		);
		expect(timedVerdict({ ...lower, ci: null })).toBe("unsure");
	});

	test("exact verdict uses the threshold as noise", () => {
		expect(exactVerdict({ deltaPct: 0, better: "lower", threshold: 0 })).toBe("same");
		expect(exactVerdict({ deltaPct: 3, better: "lower", threshold: 5 })).toBe("same");
		expect(exactVerdict({ deltaPct: 6, better: "lower", threshold: 5 })).toBe("worse");
		expect(exactVerdict({ deltaPct: -6, better: "lower", threshold: 5 })).toBe("better");
	});
});

test("summarizeMetrics keeps metrics seen on one side only", () => {
	const summaries = summarizeMetrics({
		base: [10, 11, 10, 11].map((value) => timed("a", value)),
		head: [...[20, 21, 20, 21].map((value) => timed("a", value)), timed("b", 1)],
		threshold: 0,
	});
	expect(summaries.map((s) => [s.id, s.base.n, s.head.n, s.verdict])).toEqual([
		["a", 4, 4, "worse"],
		["b", 0, 1, "unsure"],
	]);
});

test("auto settles a timed metric on a decided verdict or a narrow interval", () => {
	const summarize = (head: number[]) =>
		summarizeMetrics({
			base: [100, 101, 99, 100, 101, 99].map((value) => timed("t", value)),
			head: head.map((value) => timed("t", value)),
			threshold: 0,
		})[0];
	const unchanged = summarize([100, 99, 101, 100, 99, 101]);
	expect(unchanged?.verdict).toBe("unsure");
	expect(unchanged && settled(unchanged, 2)).toBe(true);
	const noisy = summarize([60, 140, 90, 110, 70, 130]);
	expect(noisy?.verdict).toBe("unsure");
	expect(noisy && settled(noisy, 2)).toBe(false);
});

test("a 0/1 rate row reports partial changes and never an infinite delta", () => {
	const rate = (base: number[], head: number[]) =>
		summarizeMetrics({
			base: base.map((value) => timed("w", value)),
			head: head.map((value) => timed("w", value)),
			threshold: 0,
		})[0];
	const fewerWaits = rate([1, 1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 0, 0, 0]);
	expect(fewerWaits?.deltaPct).toBeCloseTo(-42.857, 2);
	expect(fewerWaits?.verdict).toBe("unsure");
	const flipped = rate([0, 0, 0, 0, 1, 1, 1], [1, 1, 1, 1, 0, 0, 0]);
	expect(flipped?.deltaPct).toBeCloseTo(33.333, 2);
	expect(flipped?.verdict).toBe("unsure");
});
