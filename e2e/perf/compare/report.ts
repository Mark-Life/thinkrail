import type { CompareResult, MetricSummary, SideInfo, SuiteResult } from "./types";

const TIERS = [50, 20, 10, 5];
const HEADER = "| Metric | Base | Head | Δ | 95% CI | Verdict |\n|---|---:|---:|---:|---:|---|";

export function tier(deltaPct: number) {
	const size = Math.abs(deltaPct);
	if (!Number.isFinite(deltaPct)) return deltaPct === 0 ? 0 : TIERS.length;
	return TIERS.filter((limit) => size >= limit).length;
}

function trim(value: number, digits: number) {
	return Number(value.toFixed(digits)).toString();
}

export function formatValue(value: number, unit: MetricSummary["unit"]) {
	if (unit === "bytes") {
		if (Math.abs(value) < 1024) return `${trim(value, 0)} B`;
		if (Math.abs(value) < 1024 ** 2) return `${trim(value / 1024, 1)} KiB`;
		return `${trim(value / 1024 ** 2, 2)} MiB`;
	}
	if (unit === "ms") return `${trim(value, 1)} ms`;
	if (unit === "px") return `${trim(value, 1)} px`;
	if (unit === "score") return trim(value, 3);
	return trim(value, 1);
}

export function formatPct(value: number | null) {
	if (value === null || !Number.isFinite(value)) return "n/a";
	const sign = value > 0 ? "+" : "";
	return `${sign}${trim(value, Math.abs(value) < 1 ? 2 : 1)}%`;
}

function sideValue(metric: MetricSummary, side: "base" | "head") {
	const stats = metric[side];
	if (stats.n === 0) return "–";
	return formatValue(stats.median, metric.unit);
}

function delta(metric: MetricSummary) {
	if (metric.base.n === 0) return "new";
	if (metric.head.n === 0) return "removed";
	if (metric.kind === "timed") return formatPct(metric.deltaPct);
	const absolute = formatValue(metric.head.median - metric.base.median, metric.unit);
	const sign = metric.head.median > metric.base.median ? "+" : "";
	return `${sign}${absolute} (${formatPct(metric.deltaPct)})`;
}

function ci(metric: MetricSummary) {
	if (metric.kind === "exact") return "exact";
	if (!metric.ci) return "n<2";
	return `${formatPct(metric.ci.low)} … ${formatPct(metric.ci.high)}`;
}

function verdict(metric: MetricSummary) {
	if (metric.verdict !== "better" && metric.verdict !== "worse") return metric.verdict;
	const marks = "▮".repeat(tier(metric.deltaPct));
	return marks ? `${marks} ${metric.verdict}` : metric.verdict;
}

export function metricRow(metric: MetricSummary) {
	const cells = [
		metric.label,
		sideValue(metric, "base"),
		sideValue(metric, "head"),
		delta(metric),
		ci(metric),
		verdict(metric),
	];
	return `| ${cells.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`;
}

function table(metrics: readonly MetricSummary[]) {
	return [HEADER, ...metrics.map(metricRow)].join("\n");
}

function ordered(metrics: readonly MetricSummary[]) {
	return [...metrics].sort((a, b) => tier(b.deltaPct) - tier(a.deltaPct));
}

function loadLine(suite: SuiteResult) {
	if (suite.loadavg.length === 0) return null;
	const peak = suite.loadavg.reduce((max, sample) => (sample.load1 > max.load1 ? sample : max));
	const warning = peak.load1 > peak.cores ? " (above 1 per core: timings are noisy)" : "";
	return `Load: peak ${trim(peak.load1, 2)} on ${peak.cores} cores at round ${peak.round}${warning}.`;
}

export function renderSuite(suite: SuiteResult) {
	const lines = [`## ${suite.name}`, ""];
	const runs =
		suite.schedule.kind === "rounds" ? `${suite.schedule.rounds} rounds` : suite.schedule.kind;
	lines.push(`Schedule: ${runs}. Variants: ${suite.variants.map((v) => v.name).join(", ")}.`);
	const load = loadLine(suite);
	if (load) lines.push(load);
	for (const variant of suite.variants) {
		if (variant.status === "incompatible") {
			lines.push(`- Excluded \`${variant.name}\` on both sides: ${variant.reason}`);
		}
	}
	const groups = [...new Set(suite.metrics.map((metric) => metric.group))];
	for (const group of groups) {
		const metrics = suite.metrics.filter((metric) => metric.group === group);
		const changed = ordered(metrics.filter((metric) => metric.verdict !== "same"));
		const same = metrics.filter((metric) => metric.verdict === "same");
		lines.push("", `### ${group}`, "");
		lines.push(changed.length > 0 ? table(changed) : "No changes.");
		if (same.length > 0) {
			lines.push(
				"",
				`<details><summary>${same.length} unchanged</summary>`,
				"",
				table(same),
				"",
				"</details>",
			);
		}
	}
	return lines.join("\n");
}

function sideLabel(side: SideInfo) {
	const short = side.sha.slice(0, 10);
	return side.ref === side.sha || side.ref === short
		? `\`${short}\``
		: `\`${side.ref}\` (\`${short}\`)`;
}

export function renderReport(result: CompareResult) {
	const protocol =
		result.base.protocolVersion === result.head.protocolVersion
			? `${result.base.protocolVersion ?? "unknown"}`
			: `${result.base.protocolVersion ?? "unknown"} → ${result.head.protocolVersion ?? "unknown"}`;
	const header = [
		`# perf:compare ${sideLabel(result.base)} → ${sideLabel(result.head)}`,
		"",
		`Host \`${result.host}\`, tool \`${result.tool.sha.slice(0, 10)}\`${result.tool.dirty ? " (dirty)" : ""}, threshold ${result.threshold}%, protocol ${protocol}, ${result.generatedAt}.`,
	];
	const warnings =
		result.warnings.length > 0
			? ["", "Warnings:", ...result.warnings.map((warning) => `- ${warning}`)]
			: [];
	return `${[...header, ...warnings, ...result.suites.flatMap((suite) => ["", renderSuite(suite)])].join("\n")}\n`;
}
