import { expect, test } from "bun:test";
import { compile } from "@earendil-works/pi-schema";
import { WS_METHOD_SCHEMAS } from "@thinkrail/contracts";
import { checkWsResult, wireChecksOn } from "./wsResults";

test("a reply that breaks its schema fails with the method and the field", () => {
	expect(() => checkWsResult("workspace.diffStats", { added: "1", removed: 0 })).toThrow(
		/workspace\.diffStats: \/added /,
	);
});

test("checks run in every test run and in a host started with the switch, never in production", () => {
	expect(wireChecksOn({ NODE_ENV: "test" })).toBe(true);
	expect(wireChecksOn({ THINKRAIL_CHECK_WS_RESULTS: "1", NODE_ENV: "production" })).toBe(true);
	expect(wireChecksOn({ NODE_ENV: "production" })).toBe(false);
	expect(wireChecksOn({})).toBe(false);
});

test("the check reads the JSON the client gets, not the object the handler made", () => {
	expect(() => checkWsResult("feedback.survey", { survey: null, extra: undefined })).not.toThrow();
	expect(() => checkWsResult("workspace.diffStats", { added: Number.NaN, removed: 0 })).toThrow(
		/\/added /,
	);
	expect(() => checkWsResult("project.close", undefined)).toThrow(/project\.close: result /);
});

test("every result schema compiles", () => {
	for (const { result } of Object.values(WS_METHOD_SCHEMAS))
		expect(() => compile(result)).not.toThrow();
});
