import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { profileWeb } from "./artifacts";
import { failureReason, runPerfSpec } from "./playwrightRun";
import type { Measurement, SampleResult, Suite, SuiteContext } from "./types";
import {
	SHIFT_REGIONS,
	type ShiftRegion,
	TRACKED_ELEMENTS,
	type WaterfallRecord,
} from "./waterfallProbe";

const DEFAULT_ROUNDS = 7;
const VARIANT = "restore";
const REGIONS: readonly ShiftRegion[] = [...SHIFT_REGIONS, "other"];

type Row = Omit<Measurement, "id" | "group"> & { key: string };

function timedMs(key: string, label: string, value: number): Row {
	return { key, label, unit: "ms", kind: "timed", better: "lower", value };
}

function offsetMs(key: string, label: string, value: number): Row {
	return { key, label, unit: "ms", kind: "offset", better: "lower", value };
}

function orderRows(record: WaterfallRecord): Row[] {
	const { wire, chatViewChunkMs } = record;
	const waited = wire.getMessagesSentMs - wire.watchReadyReplyMs;
	return [
		{
			key: "getMessagesWaitsForWatchReady",
			label: "getMessages sent after watchReady reply (wait rate)",
			unit: "count",
			kind: "timed",
			better: "lower",
			value: waited >= 0 ? 1 : 0,
		},
		offsetMs("getMessagesAfterWatchReadyMs", "getMessages sent − watchReady reply", waited),
		...(chatViewChunkMs === null
			? []
			: [
					offsetMs(
						"chatViewAfterMessagesMs",
						"ChatView chunk loaded − getMessages reply",
						chatViewChunkMs - wire.getMessagesReplyMs,
					),
				]),
	];
}

function timingRows(record: WaterfallRecord): Row[] {
	const { wire, chatViewChunkMs, page } = record;
	return [
		timedMs("watchReadyReplyMs", "watchReady reply", wire.watchReadyReplyMs),
		timedMs("getMessagesSentMs", "getMessages sent", wire.getMessagesSentMs),
		timedMs("getMessagesReplyMs", "getMessages reply", wire.getMessagesReplyMs),
		...(chatViewChunkMs === null
			? []
			: [timedMs("chatViewChunkMs", "ChatView chunk loaded", chatViewChunkMs)]),
		...(page.typeableAt === null
			? []
			: [timedMs("typeableMs", "composer typeable", page.typeableAt)]),
		...(page.transcriptAt === null
			? []
			: [timedMs("transcriptMs", "first message painted", page.transcriptAt)]),
	];
}

function layoutRows(record: WaterfallRecord): Row[] {
	const { page } = record;
	const score = (key: string, label: string, value: number): Row => ({
		key,
		label,
		unit: "score",
		kind: "timed",
		better: "lower",
		value,
	});
	if (!page.layoutShiftSupported) {
		return TRACKED_ELEMENTS.map((name) => ({
			key: `movePx/${name}`,
			label: `${name} max move per frame`,
			unit: "px",
			kind: "timed",
			better: "lower",
			value: page.movementPx[name],
		}));
	}
	const after = page.typeableAt ?? Number.POSITIVE_INFINITY;
	const shifts = page.shifts.filter((shift) => shift.at >= after && !shift.hadRecentInput);
	const byRegion = new Map(REGIONS.map((region) => [region, 0]));
	for (const shift of shifts) {
		const regions = shift.regions.length > 0 ? shift.regions : (["other"] as const);
		for (const region of regions) {
			byRegion.set(region, (byRegion.get(region) ?? 0) + shift.value / regions.length);
		}
	}
	return [
		score("layoutShift", "layout shift after typeable", sum(shifts.map((s) => s.value))),
		score("layoutShiftMax", "largest shift", Math.max(0, ...shifts.map((s) => s.value))),
		{
			key: "layoutShiftCount",
			label: "shift count",
			unit: "count",
			kind: "timed",
			better: "lower",
			value: shifts.length,
		},
		...REGIONS.map((region) =>
			score(`layoutShift/${region}`, `shift in ${region}`, byRegion.get(region) ?? 0),
		),
	];
}

function sum(values: readonly number[]) {
	return values.reduce((total, value) => total + value, 0);
}

export function waterfallMeasurements(record: WaterfallRecord): Measurement[] {
	const groups: (readonly [string, Row[]])[] = [
		["restore order", orderRows(record)],
		["restore timing", timingRows(record)],
		["restore layout", layoutRows(record)],
	];
	return groups.flatMap(([group, rows]) =>
		rows.map(({ key, ...row }) => ({ ...row, id: `waterfall/${VARIANT}/${key}`, group })),
	);
}

async function sample(context: SuiteContext): Promise<SampleResult> {
	const result = await runPerfSpec({
		context,
		spec: "e2e/perf/compare/waterfall.perf.ts",
		browser: context.options.browser,
		env: { THINKRAIL_PERF_WATERFALL_OUT: context.sampleDir },
	});
	const file = join(context.sampleDir, "waterfall.json");
	if (result.exitCode !== 0 || !existsSync(file)) {
		return { ok: false, incompatible: failureReason(result.stdout, result.exitCode) };
	}
	const record = JSON.parse(readFileSync(file, "utf8")) as WaterfallRecord;
	return { ok: true, measurements: waterfallMeasurements(record) };
}

export const waterfallSuite: Suite = {
	name: "waterfall",
	artifacts: [profileWeb],
	optIn: true,
	schedule: (options) => ({ kind: "rounds", rounds: options.rounds ?? DEFAULT_ROUNDS }),
	variants: () => [VARIANT],
	sample,
};
