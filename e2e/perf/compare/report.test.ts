import { expect, test } from "bun:test";
import { formatValue, renderReport, tier } from "./report";
import { summarizeMetrics } from "./stats";
import type { CompareResult, Measurement, Sha } from "./types";

function measurement(id: string, kind: Measurement["kind"], value: number): Measurement {
	return {
		id,
		group: kind === "exact" ? "sizes" : "timings",
		label: id,
		unit: kind === "exact" ? "bytes" : "ms",
		kind,
		better: "lower",
		value,
	};
}

function result(): CompareResult {
	const base = [
		measurement("same.js", "exact", 2048),
		measurement("grown.js", "exact", 1000),
		...[100, 102, 98, 101].map((v) => measurement("boot", "timed", v)),
	];
	const head = [
		measurement("same.js", "exact", 2048),
		measurement("grown.js", "exact", 1300),
		...[80, 81, 79, 80].map((v) => measurement("boot", "timed", v)),
	];
	return {
		generatedAt: "2026-10-21T00:00:00.000Z",
		host: "studio",
		tool: { sha: "1234567890abcdef", dirty: false },
		base: { ref: "main", sha: "aaaaaaaaaaaaaaaa" as Sha, protocolVersion: 87 },
		head: { ref: "bbbbbbbbbb", sha: "bbbbbbbbbbbbbbbb" as Sha, protocolVersion: 88 },
		threshold: 0,
		warnings: ["protocol version differs (87 → 88)"],
		suites: [
			{
				name: "demo",
				schedule: { kind: "rounds", rounds: 4 },
				variants: [
					{ name: "a", status: "ok" },
					{ name: "b", status: "incompatible", reason: "head: missing testid" },
				],
				metrics: summarizeMetrics({ base, head, threshold: 0 }),
				loadavg: [{ round: 1, load1: 12.5, cores: 10 }],
			},
		],
	};
}

test("tiers mark 5/10/20/50 percent changes", () => {
	expect([0, 4.9, 5, 10, 20, 50, -60].map(tier)).toEqual([0, 0, 1, 2, 3, 4, 4]);
});

test("formatValue scales bytes", () => {
	expect(formatValue(512, "bytes")).toBe("512 B");
	expect(formatValue(2048, "bytes")).toBe("2 KiB");
	expect(formatValue(3 * 1024 ** 2, "bytes")).toBe("3 MiB");
});

test("renderReport collapses unchanged rows and shows CI only for timed rows", () => {
	const markdown = renderReport(result());
	expect(markdown).toContain("# perf:compare `main` (`aaaaaaaaaa`) → `bbbbbbbbbb`");
	expect(markdown).toContain("protocol 87 → 88");
	expect(markdown).toContain("- protocol version differs (87 → 88)");
	expect(markdown).toContain("Excluded `b` on both sides: head: missing testid");
	expect(markdown).toContain("above 1 per core");
	expect(markdown).toContain("| grown.js | 1000 B | 1.3 KiB | +300 B (+30%) | exact | ▮▮▮ worse |");
	expect(markdown).toMatch(
		/\| boot \| 100\.5 ms \| 80 ms \| -20\.2% \| -2\d[.\d]*% … -1\d[.\d]*% \| ▮▮▮ better \|/,
	);
	expect(markdown).toContain("<details><summary>1 unchanged</summary>");
	const collapsed = markdown.slice(markdown.indexOf("<details>"));
	expect(collapsed).toContain("| same.js | 2 KiB | 2 KiB | 0 B (0%) | exact | same |");
});

test("renderReport survives a JSON round trip of infinite deltas", () => {
	const input = result();
	const suite = input.suites[0];
	if (!suite) throw new Error("fixture has one suite");
	suite.metrics = summarizeMetrics({
		base: [],
		head: [measurement("new.js", "exact", 10)],
		threshold: 0,
	});
	const reloaded = JSON.parse(JSON.stringify(input)) as CompareResult;
	expect(renderReport(reloaded)).toContain("| new.js | – | 10 B | new | exact | ▮▮▮▮ worse |");
});
