export type Counts = Record<string, Record<string, number>>;

interface Diagnostic {
	code?: string;
	severity: string;
	filename: string;
	message: string;
	labels?: { span: { line: number; column: number } }[];
}

export interface LintResult {
	warnings: Counts;
	errors: string[];
}

export interface CountChange {
	rule: string;
	file: string;
	before: number;
	after: number;
}

export interface CountDiff {
	increases: CountChange[];
	decreases: CountChange[];
}

function isLintReport(value: unknown): value is { diagnostics: unknown[] } {
	return (
		typeof value === "object" &&
		value !== null &&
		"diagnostics" in value &&
		Array.isArray(value.diagnostics)
	);
}

function isDiagnostic(value: unknown): value is Diagnostic {
	return (
		typeof value === "object" &&
		value !== null &&
		(!("code" in value) || typeof value.code === "string") &&
		"severity" in value &&
		typeof value.severity === "string" &&
		"filename" in value &&
		typeof value.filename === "string" &&
		"message" in value &&
		typeof value.message === "string"
	);
}

function isFileCounts(value: unknown): value is Record<string, number> {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.values(value).every((count) => Number.isInteger(count))
	);
}

function isCounts(value: unknown): value is Counts {
	return typeof value === "object" && value !== null && Object.values(value).every(isFileCounts);
}

export function ruleName(code: string): string {
	const match = /^([^(]+)\((.+)\)$/.exec(code);
	return match === null ? code : `${match[1]}/${match[2]}`;
}

function sortCounts(counts: Counts) {
	const sorted: Counts = {};
	for (const rule of Object.keys(counts).sort()) {
		const files: Record<string, number> = {};
		for (const file of Object.keys(counts[rule] ?? {}).sort()) {
			files[file] = counts[rule]?.[file] ?? 0;
		}
		sorted[rule] = files;
	}
	return sorted;
}

export function parseLintReport(json: string): LintResult {
	const report: unknown = JSON.parse(json);
	if (!isLintReport(report)) {
		throw new Error("oxlint JSON report has no diagnostics array");
	}
	const warnings: Counts = {};
	const errors: string[] = [];
	for (const diagnostic of report.diagnostics) {
		if (!isDiagnostic(diagnostic)) throw new Error("oxlint JSON report has a malformed diagnostic");
		const rule = diagnostic.code === undefined ? "parse" : ruleName(diagnostic.code);
		const file = diagnostic.filename.replaceAll("\\", "/");
		if (diagnostic.severity === "warning") {
			const files = (warnings[rule] ??= {});
			files[file] = (files[file] ?? 0) + 1;
			continue;
		}
		const span = diagnostic.labels?.[0]?.span;
		const at = span === undefined ? file : `${file}:${span.line}:${span.column}`;
		errors.push(`${at} ${rule}: ${diagnostic.message}`);
	}
	return { warnings: sortCounts(warnings), errors };
}

export function parseLintRun(report: string, exitCode: number): LintResult {
	let result: LintResult;
	try {
		result = parseLintReport(report);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			warnings: {},
			errors: [
				`${report.trim()}\noxlint exited with code ${exitCode}; unreadable report: ${reason}`,
			],
		};
	}
	if (exitCode !== 0 && result.errors.length === 0) {
		return {
			...result,
			errors: [`oxlint exited with code ${exitCode} without reporting an error.`],
		};
	}
	return result;
}

export function parseBaseline(json: string): Counts {
	const baseline: unknown = JSON.parse(json);
	if (!isCounts(baseline)) throw new Error("lint baseline must map rule -> file -> count");
	return baseline;
}

export function serializeBaseline(counts: Counts): string {
	return `${JSON.stringify(sortCounts(counts), null, "\t")}\n`;
}

export function diffCounts(baseline: Counts, current: Counts): CountDiff {
	const increases: CountChange[] = [];
	const decreases: CountChange[] = [];
	const rules = new Set([...Object.keys(baseline), ...Object.keys(current)]);
	for (const rule of [...rules].sort()) {
		const files = new Set([
			...Object.keys(baseline[rule] ?? {}),
			...Object.keys(current[rule] ?? {}),
		]);
		for (const file of [...files].sort()) {
			const before = baseline[rule]?.[file] ?? 0;
			const after = current[rule]?.[file] ?? 0;
			if (after > before) increases.push({ rule, file, before, after });
			if (after < before) decreases.push({ rule, file, before, after });
		}
	}
	return { increases, decreases };
}

export function formatChange({ rule, file, before, after }: CountChange): string {
	return `  ${rule} ${file}: ${before} -> ${after}`;
}

export interface RatchetOptions {
	update: boolean;
	allowIncrease: boolean;
}

export interface RatchetOutcome {
	ok: boolean;
	messages: string[];
	nextBaseline?: string;
}

const UPDATE = "bun scripts/lint-ratchet.ts --update";

export function runRatchet(
	baseline: Counts,
	result: LintResult,
	options: RatchetOptions,
): RatchetOutcome {
	if (result.errors.length > 0) {
		return { ok: false, messages: [...result.errors, `${result.errors.length} lint error(s).`] };
	}
	const { increases, decreases } = diffCounts(baseline, result.warnings);
	const raised = ["Lint warnings rose above lint-baseline.json:", ...increases.map(formatChange)];
	if (options.update) {
		if (increases.length > 0 && !options.allowIncrease) {
			return {
				ok: false,
				messages: [...raised, "Refusing to raise the baseline without --allow-increase."],
			};
		}
		return {
			ok: true,
			messages: [
				`lint-baseline.json updated: ${decreases.length} lowered, ${increases.length} raised.`,
			],
			nextBaseline: serializeBaseline(result.warnings),
		};
	}
	if (increases.length > 0) {
		return { ok: false, messages: [...raised, "Fix the new warnings; do not raise the baseline."] };
	}
	if (decreases.length > 0) {
		return {
			ok: true,
			messages: [
				`Lint warnings dropped below lint-baseline.json. Run \`${UPDATE}\` to lock it in:`,
				...decreases.map(formatChange),
			],
		};
	}
	return { ok: true, messages: [] };
}
