import { afterEach, beforeEach, expect, test } from "bun:test";
import { compile } from "@earendil-works/pi-schema";
import {
	asProjectId,
	asSessionId,
	asWorkspaceId,
	WS_CHANNEL_SCHEMAS,
	WS_CHANNELS,
	WS_METHOD_SCHEMAS,
} from "@thinkrail/contracts";
import { handleRequest } from "./handlers";
import { checkWsPush, checkWsResult, pushFrame } from "./wsResults";

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

test("a push that breaks its schema fails with the channel and the field", () => {
	expect(() => checkWsPush("workspace.removed", { projectId: 1, id: "w" })).toThrow(
		/ws push check failed: workspace\.removed: \/projectId /,
	);
});

test("with the switch off, a bad push is not looked at", () => {
	delete process.env.THINKRAIL_CHECK_WS_RESULTS;
	expect(() => checkWsPush("workspace.removed", null)).not.toThrow();
});

test("pi.event checks only the type tag", () => {
	const push = { sessionId: asSessionId("s"), event: { type: "from_a_newer_pi", anything: 1 } };
	expect(() => checkWsPush("pi.event", push)).not.toThrow();
	expect(() => checkWsPush("pi.event", { sessionId: asSessionId("s"), event: {} })).toThrow(
		/\/event\/type /,
	);
});

test("pushFrame sends the channel and payload the client reads", () => {
	const frame = pushFrame(WS_CHANNELS.workspaceRemoved, {
		projectId: asProjectId("p"),
		id: asWorkspaceId("w"),
	});
	expect(JSON.parse(frame)).toEqual({
		channel: "workspace.removed",
		data: { projectId: asProjectId("p"), id: "w" },
	});
});

test("every channel has a schema that compiles", () => {
	for (const channel of Object.values(WS_CHANNELS))
		expect(() => compile(WS_CHANNEL_SCHEMAS[channel])).not.toThrow();
});
