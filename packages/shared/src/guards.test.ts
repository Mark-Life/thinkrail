import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { errnoCode, isRecord } from "./guards";

describe("isRecord", () => {
	test("accepts plain and null-prototype objects", () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord({ a: 1 })).toBe(true);
		expect(isRecord(Object.create(null))).toBe(true);
		expect(isRecord(new Error("x"))).toBe(true);
	});

	test("rejects arrays, null, and primitives", () => {
		for (const value of [[], [1], null, undefined, 0, "", "x", true, Symbol("s"), () => {}]) {
			expect(isRecord(value)).toBe(false);
		}
	});
});

describe("errnoCode", () => {
	test("reads the code of a real filesystem error", () => {
		let caught: unknown;
		try {
			readFileSync("/nonexistent/thinkrail-guards-test");
		} catch (error) {
			caught = error;
		}
		expect(errnoCode(caught)).toBe("ENOENT");
	});

	test("reads a string code from any object", () => {
		expect(errnoCode(Object.assign(new Error("busy"), { code: "EBUSY" }))).toBe("EBUSY");
		expect(errnoCode({ code: "EEXIST" })).toBe("EEXIST");
	});

	test("returns undefined when there is no string code", () => {
		for (const value of [
			new Error("plain"),
			{ code: 2 },
			{ code: undefined },
			{},
			null,
			undefined,
			"ENOENT",
			42,
		]) {
			expect(errnoCode(value)).toBeUndefined();
		}
	});
});
