import { expect, test } from "bun:test";
import { compile } from "@earendil-works/pi-schema";
import { WS_CHANNEL_SCHEMAS, WS_CHANNELS, WS_METHOD_SCHEMAS } from "@thinkrail/contracts";
import { testProjectId, testSessionId, testWorkspaceId } from "@thinkrail/contracts/test-ids";
import { checkWsPush, checkWsResult, pushFrame, wireChecksOn } from "./wsResults";

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

test("a push that breaks its schema fails with the channel and the field", () => {
	expect(() => checkWsPush("workspace.removed", { projectId: 1, id: "w" })).toThrow(
		/ws push check failed: workspace\.removed: \/projectId /,
	);
});

test("pi.event checks the type tag against pi's event types, not the body", () => {
	const push = { sessionId: testSessionId("s"), event: { type: "message_end", anything: 1 } };
	expect(() => checkWsPush("pi.event", push)).not.toThrow();
	for (const event of [{ type: "from_a_newer_pi" }, {}])
		expect(() => checkWsPush("pi.event", { sessionId: testSessionId("s"), event })).toThrow(
			/\/event\/type /,
		);
});

test("pushFrame sends the channel and payload the client reads", () => {
	const frame = pushFrame(WS_CHANNELS.workspaceRemoved, {
		projectId: testProjectId("p"),
		id: testWorkspaceId("w"),
	});
	expect(JSON.parse(frame)).toEqual({
		channel: "workspace.removed",
		data: { projectId: testProjectId("p"), id: "w" },
	});
});

test("every channel has a schema that compiles", () => {
	for (const channel of Object.values(WS_CHANNELS))
		expect(() => compile(WS_CHANNEL_SCHEMAS[channel])).not.toThrow();
});
