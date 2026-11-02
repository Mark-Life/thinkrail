import { afterEach, beforeEach, expect, test } from "bun:test";
import { compile } from "@earendil-works/pi-schema";
import { WS_METHOD_SCHEMAS } from "@thinkrail/contracts";
import { handleRequest } from "./handlers";
import { checkWsResult } from "./wsResults";

const SAVED = process.env.THINKRAIL_CHECK_WS_RESULTS;

beforeEach(() => {
	process.env.THINKRAIL_CHECK_WS_RESULTS = "1";
});

afterEach(() => {
	if (SAVED === undefined) delete process.env.THINKRAIL_CHECK_WS_RESULTS;
	else process.env.THINKRAIL_CHECK_WS_RESULTS = SAVED;
});

test("a reply that breaks its schema fails with the method and the field", () => {
	expect(() => checkWsResult("workspace.diffStats", { added: "1", removed: 0 })).toThrow(
		/workspace\.diffStats: \/added /,
	);
});

test("with the switch off, a bad reply is not looked at", () => {
	delete process.env.THINKRAIL_CHECK_WS_RESULTS;
	expect(() => checkWsResult("workspace.diffStats", null)).not.toThrow();
});

test("the check reads the JSON the client gets, not the object the handler made", () => {
	expect(() => checkWsResult("feedback.survey", { survey: null, extra: undefined })).not.toThrow();
	expect(() => checkWsResult("workspace.diffStats", { added: Number.NaN, removed: 0 })).toThrow(
		/\/added /,
	);
	expect(() => checkWsResult("project.close", undefined)).toThrow(/project\.close: result /);
});

test("handleRequest refuses a handler's reply that breaks its schema", async () => {
	const entry = WS_METHOD_SCHEMAS["session.activityList"];
	const { result } = entry;
	Reflect.set(entry, "result", { type: "object" });
	try {
		await expect(
			handleRequest("session.activityList", {}, { clientKey: "ws-results-test" }),
		).rejects.toThrow(/session\.activityList/);
	} finally {
		Reflect.set(entry, "result", result);
	}
});

test("every result schema compiles", () => {
	for (const { result } of Object.values(WS_METHOD_SCHEMAS))
		expect(() => compile(result)).not.toThrow();
});
