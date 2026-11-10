import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { CLIENT_ERROR_REPORT_PROTOCOL_VERSION } from "@thinkrail/contracts";
import { useAppStore } from "../store";
import {
	chunkIdsForStack,
	clientErrorReport,
	installClientErrorReporting,
	reportClientError,
	reportDroppedFrame,
	reportHandledFailure,
	reportInvalidReply,
	resetClientErrorReportsForTests,
	supportsClientErrorReports,
} from "./errorReports";
import { RequestError } from "./requestError";
import { type FakeRequest, fakeTransport } from "./transportFixtures.test";
import * as wireTransport from "./wireTransport";

const requests: FakeRequest[] = [];
let spy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
	requests.length = 0;
	resetClientErrorReportsForTests();
	useAppStore.setState({ protocolVersion: null });
	spy = spyOn(wireTransport, "getTransport").mockReturnValue(
		fakeTransport(() => ({ ok: true }), requests),
	);
});

afterEach(() => {
	spy?.mockRestore();
	resetClientErrorReportsForTests();
	useAppStore.setState({ protocolVersion: null });
});

test("an invalid reply reports its method and code only, and a report's own reply never reports", () => {
	useAppStore.setState({ protocolVersion: CLIENT_ERROR_REPORT_PROTOCOL_VERSION });
	reportInvalidReply("client.reportError");
	expect(requests).toEqual([]);
	reportInvalidReply("project.list");
	expect(requests).toEqual([
		{
			method: "client.reportError",
			params: {
				kind: "rejection",
				type: "RequestError",
				boundary: "INVALID_REPLY:project.list",
			},
		},
	]);
});

test("a dropped frame reports its code and channel only", () => {
	useAppStore.setState({ protocolVersion: CLIENT_ERROR_REPORT_PROTOCOL_VERSION });
	reportDroppedFrame({ code: "INVALID_PUSH", channel: "pi.event" });
	reportDroppedFrame({ code: "UNKNOWN_PUSH" });
	expect(requests.map((request) => request.params)).toEqual([
		{ kind: "window", type: "WireError", boundary: "INVALID_PUSH:pi.event" },
		{ kind: "window", type: "WireError", boundary: "UNKNOWN_PUSH" },
	]);
});

test("a handled failure reports its own code or the fallback, once per place, never its message", () => {
	useAppStore.setState({ protocolVersion: CLIENT_ERROR_REPORT_PROTOCOL_VERSION });
	reportHandledFailure(
		"chat-hydrate",
		new RequestError("SESSION_UNKNOWN", "secret text"),
		"HOST_ERROR",
	);
	reportHandledFailure("chat-hydrate", new RequestError("SESSION_UNKNOWN", "again"), "HOST_ERROR");
	reportHandledFailure("prefs-write", new Error("quota"), "STATE_FILE_WRITE_FAILED");
	const reports = requests.map((request) => request.params);
	expect(reports).toMatchObject([
		{ kind: "rejection", type: "RequestError", boundary: "SESSION_UNKNOWN:chat-hydrate" },
		{ kind: "rejection", type: "Error", boundary: "STATE_FILE_WRITE_FAILED:prefs-write" },
	]);
	expect(JSON.stringify(reports)).not.toContain("secret text");
});

test("reports are offered only to a host at or beyond the v90 capability", () => {
	expect(supportsClientErrorReports(CLIENT_ERROR_REPORT_PROTOCOL_VERSION)).toBe(true);
	expect(supportsClientErrorReports(CLIENT_ERROR_REPORT_PROTOCOL_VERSION - 1)).toBe(false);
	expect(supportsClientErrorReports(null)).toBe(false);
});

test("a report carries the error's class, stack and boundary, never its message", () => {
	const error = new TypeError("bad");
	expect(clientErrorReport("render", error, "chat")).toEqual({
		kind: "render",
		type: "TypeError",
		stack: (error.stack ?? "").replace("bad", ""),
		boundary: "chat",
	});
	expect(clientErrorReport("rejection", { secret: true })).toEqual({
		kind: "rejection",
		type: "UnhandledRejection",
	});
	expect(clientErrorReport("rejection", "jane@example.com")).toEqual({
		kind: "rejection",
		type: "UnhandledRejection",
	});
});

test("the message is cut out of the stack, even when its lines look like frames", () => {
	const hook = new Error(
		"push rejected\n    at calculateCustomerSalary (http://127.0.0.1:4317/src/customer-payroll.js:7:2)",
	);
	const stack = clientErrorReport("rejection", hook).stack ?? "";
	expect(stack).not.toContain("calculateCustomerSalary");
	expect(stack).not.toContain("push rejected");
	expect(stack).toContain("errorReports.test.ts");
	const webkit = Object.assign(new Error("not in a WebKit stack"), {
		stack: "render@http://127.0.0.1:4317/assets/index-abc.js:10:5",
	});
	expect(clientErrorReport("window", webkit).stack).toBe(
		"render@http://127.0.0.1:4317/assets/index-abc.js:10:5",
	);
});

test("an error with a non-string name still reports a string type", () => {
	const error = Object.assign(new Error("odd"), { name: 42 });
	expect(clientErrorReport("window", error).type).toBe("Error");
});

test("reports before the welcome wait for the protocol and are dropped by older hosts", () => {
	reportClientError(clientErrorReport("window", new Error("early")));
	expect(requests).toEqual([]);
	useAppStore.setState({ protocolVersion: CLIENT_ERROR_REPORT_PROTOCOL_VERSION });
	expect(requests.map((request) => request.method)).toEqual(["client.reportError"]);

	requests.length = 0;
	useAppStore.setState({ protocolVersion: CLIENT_ERROR_REPORT_PROTOCOL_VERSION - 1 });
	reportClientError(clientErrorReport("window", new Error("old host")));
	expect(requests).toEqual([]);
});

test("a page sends at most 50 reports", () => {
	useAppStore.setState({ protocolVersion: CLIENT_ERROR_REPORT_PROTOCOL_VERSION });
	for (let i = 0; i < 60; i++) reportClientError(clientErrorReport("window", new Error(`e${i}`)));
	expect(requests).toHaveLength(50);
});

test("window errors and unhandled rejections are forwarded until uninstalled", () => {
	useAppStore.setState({ protocolVersion: CLIENT_ERROR_REPORT_PROTOCOL_VERSION });
	const target = new EventTarget();
	const uninstall = installClientErrorReporting(target);
	const error = Object.assign(new Event("error"), {
		error: new RangeError("boom"),
		message: "boom",
	});
	target.dispatchEvent(error);
	const rejection = Object.assign(new Event("unhandledrejection"), { reason: new Error("nope") });
	target.dispatchEvent(rejection);
	uninstall();
	target.dispatchEvent(error);
	expect(requests.map((request) => request.params)).toMatchObject([
		{ kind: "window", type: "RangeError" },
		{ kind: "rejection", type: "Error" },
	]);
});

test("chunk ids are matched from PostHog's registry only for urls in the error's stack", () => {
	const app = "http://127.0.0.1:4317/assets/index-abc.js";
	const lazy = "http://127.0.0.1:4317/assets/Pane-def.js";
	const registry = {
		[`Error\n    at ${app}:1:120`]: "ab8fcdab-5c22-55ed-bec8-0f9acb6a407e",
		[`@${lazy}:1:64`]: "11111111-2222-5333-8444-555555555555",
		"Error\n    at http://127.0.0.1:4317/assets/other.js:1:1":
			"22222222-2222-5333-8444-555555555555",
	};
	expect(chunkIdsForStack(`TypeError: x\n    at f (${app}:10:5)\ng@${lazy}:3:9`, registry)).toEqual(
		{
			[app]: "ab8fcdab-5c22-55ed-bec8-0f9acb6a407e",
			[lazy]: "11111111-2222-5333-8444-555555555555",
		},
	);
	expect(chunkIdsForStack(`at f (${app}:1:1)`, undefined)).toBeUndefined();
	expect(chunkIdsForStack("no urls here", registry)).toBeUndefined();
});
