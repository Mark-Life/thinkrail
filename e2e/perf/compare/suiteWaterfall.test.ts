import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { waterfallMeasurements } from "./suiteWaterfall";
import { type WaterfallRecord, type WireFrame, wireTimeline } from "./waterfallProbe";

function fixture<T>(name: string): T {
	return JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "waterfall", name), "utf8"));
}

function byId(record: WaterfallRecord) {
	return new Map(waterfallMeasurements(record).map((row) => [row.id, row]));
}

const params = { workspaceId: "w1" };

function frame(at: number, direction: WireFrame["direction"], body: object): WireFrame {
	return { at, direction, payload: JSON.stringify(body) };
}

function restoreFrames(getMessagesAt: number) {
	return [
		frame(1, "sent", { id: "l", method: "workspace.list", params: {} }),
		frame(2, "sent", { id: "w", method: "workspace.watchReady", params }),
		frame(3, "received", { id: "l", ok: true }),
		frame(getMessagesAt, "sent", { id: "m", method: "session.getMessages", params }),
		frame(20, "received", { id: "w", ok: true }),
		frame(30, "received", { id: "m", ok: true }),
	].sort((a, b) => a.at - b.at);
}

describe("wire timeline", () => {
	test("base sends getMessages only after the watchReady reply", () => {
		const timeline = wireTimeline(restoreFrames(21));
		expect(timeline.getMessagesSentMs).toBeGreaterThanOrEqual(timeline.watchReadyReplyMs);
		expect(timeline.getMessagesReplyMs).toBeGreaterThan(timeline.getMessagesSentMs);
	});

	test("head sends getMessages before the watchReady reply", () => {
		const timeline = wireTimeline(restoreFrames(5));
		expect(timeline.getMessagesSentMs).toBeLessThan(timeline.watchReadyReplyMs);
	});

	test("accepts getMessages sent before watchReady", () => {
		const timeline = wireTimeline([
			frame(10, "sent", { id: "m", method: "session.getMessages", params }),
			frame(11, "sent", { id: "w", method: "workspace.watchReady", params }),
			frame(12, "received", { id: "m", result: [] }),
			frame(13, "received", { id: "w", result: null }),
		]);
		expect(timeline).toEqual({
			watchReadyReplyMs: 13,
			getMessagesSentMs: 10,
			getMessagesReplyMs: 12,
		});
	});

	test("fails without a transcript read", () => {
		const frames = restoreFrames(5).filter(
			(frame) => !frame.payload.includes("session.getMessages"),
		);
		expect(() => wireTimeline(frames)).toThrow("no session.getMessages request");
	});
});

describe("waterfall measurements", () => {
	test("order flag separates base from head", () => {
		const id = "waterfall/restore/getMessagesWaitsForWatchReady";
		expect(byId(fixture("base-chromium.json")).get(id)).toMatchObject({ kind: "timed", value: 1 });
		expect(byId(fixture("head-chromium.json")).get(id)).toMatchObject({ kind: "timed", value: 0 });
	});

	test("counts only shifts after the composer is typeable, split by region", () => {
		const record = fixture<WaterfallRecord>("head-chromium.json");
		const typeable = record.page.typeableAt ?? 0;
		const after = record.page.shifts.filter((shift) => shift.at >= typeable);
		const rows = byId(record);
		const total = after.reduce((sum, shift) => sum + shift.value, 0);
		expect(rows.get("waterfall/restore/layoutShift")?.value).toBeCloseTo(total, 12);
		expect(rows.get("waterfall/restore/layoutShiftCount")?.value).toBe(after.length);
		const regions = [...rows.values()].filter((row) => row.id.includes("/layoutShift/"));
		expect(regions.reduce((sum, row) => sum + row.value, 0)).toBeCloseTo(total, 12);
	});

	test("every sample reports the same ids for one browser", () => {
		const ids = (name: string) =>
			waterfallMeasurements(fixture(name))
				.map((row) => row.id)
				.sort();
		expect(ids("base-chromium.json")).toEqual(ids("head-chromium.json"));
	});

	test("webkit falls back to per-frame movement", () => {
		const rows = byId(fixture("head-webkit.json"));
		expect(rows.has("waterfall/restore/layoutShift")).toBe(false);
		expect(rows.get("waterfall/restore/movePx/chat-row")).toMatchObject({ unit: "px" });
	});
});
