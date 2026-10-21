import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeMetrics } from "./stats";
import {
	componentMeasurements,
	markTimingOnly,
	pinnedComponents,
	scenarioMeasurements,
	selectScenarios,
	topComponents,
} from "./suiteRenders";

const run = JSON.parse(
	readFileSync(join(import.meta.dir, "fixtures", "renders", "chat-streaming-1.json"), "utf8"),
);

describe("renders suite mapping", () => {
	test("maps a captured run to timed scenario metrics", () => {
		const rows = scenarioMeasurements(run);
		const byId = new Map(rows.map((row) => [row.id, row]));
		expect(byId.get("renders/chat-streaming/totalMs")?.value).toBe(run.profile.totalMs);
		expect(byId.get("renders/chat-streaming/commits")).toMatchObject({
			unit: "count",
			value: run.profile.commits,
		});
		expect(byId.get("renders/chat-streaming/markdownSelfMs")?.value).toBe(
			run.profile.subtrees.markdown.selfTotalMs,
		);
		expect(rows.every((row) => row.kind === "timed" && row.group === "chat-streaming")).toBe(true);
	});

	test("ranks components by self ms and zero-fills absent ones", () => {
		const names = topComponents(run, 3);
		const selfMs = names.map((name) => run.profile.components[name].selfTotalMs);
		expect(selfMs).toEqual([...selfMs].sort((a, b) => b - a));
		const rows = componentMeasurements(run, [...names, "NotRendered"]);
		expect(rows).toHaveLength(12);
		expect(rows.filter((row) => row.id.includes("/NotRendered/")).map((row) => row.value)).toEqual([
			0, 0, 0,
		]);
	});

	test("pins a scenario's key components and none for unknown names", () => {
		expect(pinnedComponents("review-panel")).toContain("CommentRow");
		expect(pinnedComponents("plan-pane")).toContain("ItemBlock");
		expect(pinnedComponents("chat-streaming")).toEqual([]);
		expect(pinnedComponents("nope")).toEqual([]);
	});

	test("validates scenario names against the tool", () => {
		expect(selectScenarios(["large-diff"])).toEqual(["large-diff"]);
		expect(() => selectScenarios(["nope"])).toThrow("unknown scenario: nope");
	});

	test("marks a component self-ms change as timing only when its counts hold", () => {
		const names = ["Steady", "Busier"];
		const sides = (selfMs: number, busierRenders: number) =>
			[0, 1, 2].flatMap((jitter) =>
				componentMeasurements(
					{
						...run,
						profile: {
							...run.profile,
							components: {
								Steady: { selfTotalMs: selfMs + jitter, commits: 4, renders: 6 },
								Busier: { selfTotalMs: selfMs + jitter, commits: 4, renders: busierRenders },
							},
						},
					},
					names,
				),
			);
		const metrics = markTimingOnly(
			summarizeMetrics({ base: sides(10, 6), head: sides(30, 9), threshold: 0 }),
		);
		const flagged = metrics.filter((metric) => metric.timingOnly).map((metric) => metric.id);
		expect(flagged).toEqual(["renders/chat-streaming/component/Steady/selfMs"]);
		expect(metrics.find((m) => m.id.endsWith("Busier/selfMs"))?.verdict).toBe("worse");
	});
});
