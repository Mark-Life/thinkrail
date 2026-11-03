import { describe, expect, test } from "bun:test";
import { clampWidth, nextHistoryPosition, parseStoredWidth, readEntryPosition } from "./panes";

describe("clampWidth", () => {
	test("keeps a width inside the limits", () => {
		expect(clampWidth({ width: 100, min: 200, max: 600 })).toBe(200);
		expect(clampWidth({ width: 900, min: 200, max: 600 })).toBe(600);
		expect(clampWidth({ width: 300.4, min: 200, max: 600 })).toBe(300);
	});

	test("the minimum wins in a narrow window", () => {
		expect(clampWidth({ width: 500, min: 280, max: 100 })).toBe(280);
	});
});

describe("parseStoredWidth", () => {
	test("reads a stored number and rejects anything else", () => {
		expect(parseStoredWidth({ stored: "420", fallback: 300 })).toBe(420);
		expect(parseStoredWidth({ stored: null, fallback: 300 })).toBe(300);
		expect(parseStoredWidth({ stored: "wide", fallback: 300 })).toBe(300);
	});
});

describe("history position", () => {
	test("a new link cuts off forward history", () => {
		expect(nextHistoryPosition({ current: { position: 1, last: 4 }, entry: undefined })).toEqual({
			position: 2,
			last: 2,
		});
	});

	test("back and forward keep the last position", () => {
		expect(nextHistoryPosition({ current: { position: 3, last: 4 }, entry: 2 })).toEqual({
			position: 2,
			last: 4,
		});
	});

	test("reads only a numeric position from history state", () => {
		expect(readEntryPosition({ repoMapPosition: 3 })).toBe(3);
		expect(readEntryPosition({ repoMapPosition: "3" })).toBeUndefined();
		expect(readEntryPosition(null)).toBeUndefined();
	});
});
