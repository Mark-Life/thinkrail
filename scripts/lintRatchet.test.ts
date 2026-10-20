import { expect, test } from "bun:test";
import {
	parseBaseline,
	parseLintReport,
	parseLintRun,
	runRatchet,
	serializeBaseline,
} from "./lintRatchet";

function report(diagnostics: { code?: string; severity: string; filename: string }[]) {
	return JSON.stringify({
		diagnostics: diagnostics.map((diagnostic) => ({
			...diagnostic,
			message: "msg",
			labels: [{ span: { line: 3, column: 7 } }],
		})),
	});
}

const warn = (code: string, filename: string) => ({ code, severity: "warning", filename });
const check = { update: false, allowIncrease: false };

test("warnings are counted per rule and file with config-style rule names and posix paths", () => {
	const result = parseLintReport(
		report([
			warn("anti-slop(no-reflect-get)", "b.ts"),
			warn("anti-slop(no-reflect-get)", "a\\x.ts"),
			warn("anti-slop(no-reflect-get)", "b.ts"),
			warn("eslint(no-unsafe-optional-chaining)", "a\\x.ts"),
		]),
	);
	expect(result.errors).toEqual([]);
	expect(serializeBaseline(result.warnings)).toBe(
		`${JSON.stringify(
			{
				"anti-slop/no-reflect-get": { "a/x.ts": 1, "b.ts": 2 },
				"eslint/no-unsafe-optional-chaining": { "a/x.ts": 1 },
			},
			null,
			"\t",
		)}\n`,
	);
});

test("serialization is stable regardless of insertion order", () => {
	expect(serializeBaseline({ z: { b: 1, a: 2 }, a: { c: 3 } })).toBe(
		serializeBaseline({ a: { c: 3 }, z: { a: 2, b: 1 } }),
	);
});

test("errors fail the ratchet even with an unchanged baseline", () => {
	const result = parseLintReport(
		report([{ code: "eslint(eqeqeq)", severity: "error", filename: "a.ts" }]),
	);
	const outcome = runRatchet({}, result, check);
	expect(outcome.ok).toBe(false);
	expect(outcome.messages[0]).toBe("a.ts:3:7 eslint/eqeqeq: msg");
});

test("a raised count or a new rule/file pair fails the check", () => {
	const baseline = { "x/r": { "a.ts": 1 } };
	const same = parseLintReport(report([warn("x(r)", "a.ts")]));
	const raised = parseLintReport(report([warn("x(r)", "a.ts"), warn("x(r)", "a.ts")]));
	const added = parseLintReport(report([warn("x(r)", "a.ts"), warn("x(r)", "b.ts")]));
	expect(runRatchet(baseline, same, check)).toEqual({ ok: true, messages: [] });
	expect(runRatchet(baseline, raised, check)).toMatchObject({ ok: false });
	expect(runRatchet(baseline, raised, check).messages).toContain("  x/r a.ts: 1 -> 2");
	expect(runRatchet(baseline, added, check).messages).toContain("  x/r b.ts: 0 -> 1");
});

test("a dropped count passes with a hint and leaves the baseline alone", () => {
	const outcome = runRatchet(
		{ "x/r": { "a.ts": 2 } },
		parseLintReport(report([warn("x(r)", "a.ts")])),
		check,
	);
	expect(outcome.ok).toBe(true);
	expect(outcome.nextBaseline).toBeUndefined();
	expect(outcome.messages).toContain("  x/r a.ts: 2 -> 1");
});

test("--update lowers the baseline but refuses a raise without --allow-increase", () => {
	const baseline = { "x/r": { "a.ts": 1, "b.ts": 1 } };
	const current = parseLintReport(report([warn("x(r)", "a.ts"), warn("x(r)", "c.ts")]));
	const lowered = parseLintReport(report([warn("x(r)", "a.ts")]));
	const update = { update: true, allowIncrease: false };

	const refused = runRatchet(baseline, current, update);
	expect(refused.ok).toBe(false);
	expect(refused.nextBaseline).toBeUndefined();
	expect(parseBaseline(runRatchet(baseline, lowered, update).nextBaseline ?? "")).toEqual({
		"x/r": { "a.ts": 1 },
	});
	expect(
		parseBaseline(
			runRatchet(baseline, current, { update: true, allowIncrease: true }).nextBaseline ?? "",
		),
	).toEqual({ "x/r": { "a.ts": 1, "c.ts": 1 } });
});

test("malformed reports and baselines are rejected", () => {
	expect(() => parseLintReport("{}")).toThrow("no diagnostics array");
	expect(() => parseLintReport(JSON.stringify({ diagnostics: [{ code: 1 }] }))).toThrow(
		"malformed",
	);
	expect(() => parseBaseline(JSON.stringify({ r: { "a.ts": "1" } }))).toThrow("rule -> file");
});

test("a parse error without a rule code keeps its location and message", () => {
	expect(parseLintReport(report([{ severity: "error", filename: "bad.ts" }])).errors).toEqual([
		"bad.ts:3:7 parse: msg",
	]);
});

test("an unreadable report surfaces the raw oxlint output and exit code", () => {
	const result = parseLintRun("Failed to load JS plugin", 1);
	expect(result.errors).toHaveLength(1);
	expect(result.errors[0]).toContain("Failed to load JS plugin");
	expect(result.errors[0]).toContain("oxlint exited with code 1");
	expect(runRatchet({}, result, check).ok).toBe(false);
});

test("a nonzero oxlint exit fails even when the report lists no errors", () => {
	expect(parseLintRun(report([]), 2).errors).toEqual([
		"oxlint exited with code 2 without reporting an error.",
	]);
	expect(parseLintRun(report([]), 0).errors).toEqual([]);
});
