export type Side = "base" | "head";
export type Sha = string & { readonly __brand: "Sha" };
export type Env = Record<string, string>;

export interface Measurement {
	id: string;
	group: string;
	label: string;
	unit: "ms" | "bytes" | "count" | "score" | "px";
	kind: "exact" | "timed" | "offset";
	better: "lower" | "higher";
	value: number;
}

export type SampleResult =
	| { ok: true; measurements: Measurement[]; raw?: unknown }
	| { ok: false; incompatible: string };

export type Schedule =
	| { kind: "once" }
	| { kind: "rounds"; rounds: number }
	| { kind: "auto"; minRuns: number; batch: number; maxMinutes: number };

export interface Artifact {
	key: "profile-web" | "manifest-web" | "binary" | "desktop";
	inputs: readonly string[];
	build(appRoot: string, env: Env): Promise<void>;
	platforms?: readonly NodeJS.Platform[];
}

export interface CompareOptions {
	suites: readonly string[];
	scenarios: readonly string[] | null;
	rounds: number | null;
	startup: readonly string[];
	minRuns: number;
	maxMinutes: number;
	threshold: number;
	cpu: number;
	browser: "chromium" | "webkit";
	strictProtocol: boolean;
	out: string;
	rebuild: boolean;
	jsonOnly: boolean;
}

export interface SuiteContext {
	side: Side;
	sha: Sha;
	appRoot: string;
	toolRoot: string;
	sampleDir: string;
	round: number;
	options: CompareOptions;
}

export interface Suite<Name extends string = string> {
	name: Name;
	artifacts: readonly Artifact[] | ((options: CompareOptions) => readonly Artifact[]);
	browser: boolean;
	optIn?: boolean;
	schedule(options: CompareOptions): Schedule;
	variants(options: CompareOptions): readonly string[];
	sample(context: SuiteContext, variant: string): Promise<SampleResult>;
}

export interface SampleStats {
	n: number;
	median: number;
	mean: number;
	spreadPct: number;
	values: number[];
}

export interface Interval {
	low: number;
	high: number;
}

export type Verdict = "better" | "worse" | "same" | "unsure";

export interface MetricSummary extends Omit<Measurement, "value"> {
	base: SampleStats;
	head: SampleStats;
	deltaPct: number;
	ci: Interval | null;
	verdict: Verdict;
}

export type VariantStatus =
	| { name: string; status: "ok" }
	| { name: string; status: "incompatible"; reason: string };

export interface LoadSample {
	round: number;
	load1: number;
	cores: number;
}

export interface SideInfo {
	ref: string;
	sha: Sha;
	protocolVersion: number | null;
}

export interface SuiteResult {
	name: string;
	schedule: Schedule;
	variants: VariantStatus[];
	metrics: MetricSummary[];
	loadavg: LoadSample[];
}

export interface CompareResult {
	generatedAt: string;
	host: string;
	tool: { sha: string; dirty: boolean };
	base: SideInfo;
	head: SideInfo;
	threshold: number;
	warnings: string[];
	suites: SuiteResult[];
}
