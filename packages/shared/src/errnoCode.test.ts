import { describe, expect, test } from "bun:test";
import { errnoCode } from "./errnoCode";

describe("errnoCode", () => {
	test("reads a string code from an error", () => {
		expect(errnoCode(Object.assign(new Error("x"), { code: "ENOENT" }))).toBe("ENOENT");
	});

	test("reads a string code from a plain object", () => {
		expect(errnoCode({ code: "EEXIST" })).toBe("EEXIST");
	});

	test("ignores non-string codes and non-objects", () => {
		expect(errnoCode({ code: 2 })).toBeUndefined();
		expect(errnoCode(new Error("x"))).toBeUndefined();
		expect(errnoCode(null)).toBeUndefined();
		expect(errnoCode("ENOENT")).toBeUndefined();
	});
});
