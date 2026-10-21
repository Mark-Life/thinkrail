import type { Interval, Measurement, MetricSummary, SampleStats, Verdict } from "./types";

const T_95 = [
	12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
	2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048,
	2.045, 2.042,
];

export function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[middle] ?? 0)
		: ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function mean(values: readonly number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function variance(values: readonly number[]): number {
	if (values.length < 2) return 0;
	const center = mean(values);
	return values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1);
}

export function spreadPct(values: readonly number[]): number {
	const middle = median(values);
	if (values.length === 0 || middle === 0) return 0;
	return ((Math.max(...values) - Math.min(...values)) / middle) * 100;
}

export function tCritical95(df: number): number {
	if (!Number.isFinite(df) || df > T_95.length) return 1.96;
	return T_95[Math.max(1, Math.floor(df)) - 1] ?? 1.96;
}

export function sampleStats(values: readonly number[]): SampleStats {
	return {
		n: values.length,
		median: median(values),
		mean: mean(values),
		spreadPct: spreadPct(values),
		values: [...values],
	};
}

export function relativeDifferenceCi(
	base: readonly number[],
	head: readonly number[],
): Interval | null {
	if (base.length < 2 || head.length < 2) return null;
	const baseMean = mean(base);
	const headMean = mean(head);
	if (baseMean === 0 && headMean === 0 && variance(base) === 0 && variance(head) === 0) {
		return { low: 0, high: 0 };
	}
	if (baseMean === 0 || headMean === 0) return null;
	const ratio = headMean / baseMean;
	const headTerm = variance(head) / (head.length * headMean ** 2);
	const baseTerm = variance(base) / (base.length * baseMean ** 2);
	const total = headTerm + baseTerm;
	if (total === 0) return { low: (ratio - 1) * 100, high: (ratio - 1) * 100 };
	const df = total ** 2 / (headTerm ** 2 / (head.length - 1) + baseTerm ** 2 / (base.length - 1));
	const margin = tCritical95(df) * ratio * Math.sqrt(total);
	return { low: (ratio - margin - 1) * 100, high: (ratio + margin - 1) * 100 };
}

export function differenceCi(base: readonly number[], head: readonly number[]): Interval | null {
	if (base.length < 2 || head.length < 2) return null;
	const difference = mean(head) - mean(base);
	const headTerm = variance(head) / head.length;
	const baseTerm = variance(base) / base.length;
	const total = headTerm + baseTerm;
	if (total === 0) return { low: difference, high: difference };
	const df = total ** 2 / (headTerm ** 2 / (head.length - 1) + baseTerm ** 2 / (base.length - 1));
	const margin = tCritical95(df) * Math.sqrt(total);
	return { low: difference - margin, high: difference + margin };
}

export function relativeDelta(base: number, head: number): number {
	if (base === head) return 0;
	if (base === 0) return head > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
	return (head / base - 1) * 100;
}

function directional(deltaPct: number, better: Measurement["better"]): Verdict {
	return (better === "lower") === deltaPct < 0 ? "better" : "worse";
}

export function exactVerdict(input: {
	deltaPct: number;
	better: Measurement["better"];
	threshold: number;
}): Verdict {
	if (input.deltaPct === 0 || Math.abs(input.deltaPct) <= input.threshold) return "same";
	return directional(input.deltaPct, input.better);
}

export function timedVerdict(input: {
	ci: Interval | null;
	better: Measurement["better"];
	threshold: number;
}): Verdict {
	const { ci, threshold } = input;
	if (!ci) return "unsure";
	if (ci.low === 0 && ci.high === 0) return "same";
	if (ci.high < -threshold) return directional(-1, input.better);
	if (ci.low > threshold) return directional(1, input.better);
	if (threshold > 0 && ci.low >= -threshold && ci.high <= threshold) return "same";
	return "unsure";
}

export function summarizeMetric(input: {
	base: readonly Measurement[];
	head: readonly Measurement[];
	threshold: number;
}): MetricSummary | null {
	const first = input.base[0] ?? input.head[0];
	if (!first) return null;
	const { value: _value, ...meta } = first;
	const base = sampleStats(input.base.map((m) => m.value));
	const head = sampleStats(input.head.map((m) => m.value));
	if (meta.kind === "exact") {
		const deltaPct = relativeDelta(base.median, head.median);
		const verdict = exactVerdict({ deltaPct, better: meta.better, threshold: input.threshold });
		return { ...meta, base, head, deltaPct, ci: null, verdict };
	}
	if (meta.kind === "offset") {
		const ci = differenceCi(base.values, head.values);
		const verdict = timedVerdict({ ci, better: meta.better, threshold: 0 });
		return { ...meta, base, head, deltaPct: 0, ci, verdict };
	}
	const ci = relativeDifferenceCi(base.values, head.values);
	const deltaPct = relativeDelta(base.mean, head.mean);
	const verdict = timedVerdict({ ci, better: meta.better, threshold: input.threshold });
	return { ...meta, base, head, deltaPct, ci, verdict };
}

export function summarizeMetrics(input: {
	base: readonly Measurement[];
	head: readonly Measurement[];
	threshold: number;
}): MetricSummary[] {
	const ids = [...new Set([...input.base, ...input.head].map((m) => m.id))];
	return ids.flatMap((id) => {
		const summary = summarizeMetric({
			base: input.base.filter((m) => m.id === id),
			head: input.head.filter((m) => m.id === id),
			threshold: input.threshold,
		});
		return summary ? [summary] : [];
	});
}
