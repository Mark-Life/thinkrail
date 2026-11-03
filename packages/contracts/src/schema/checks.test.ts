import { describe, expect, test } from "bun:test";
import {
	parseEnvelope,
	protocolMismatch,
	pushFailure,
	resultFailure,
	resultProblem,
	welcomeFailure,
} from "./checks";
import { PROTOCOL_VERSION } from "./host";

const NEWER = PROTOCOL_VERSION + 1;
const OLDER = PROTOCOL_VERSION - 1;

describe("protocolMismatch", () => {
	test.each<[string, unknown, ReturnType<typeof protocolMismatch>]>([
		["the same version", { protocolVersion: PROTOCOL_VERSION, projects: [] }, null],
		["the same version with no projects", { protocolVersion: PROTOCOL_VERSION }, "uiOutdated"],
		[
			"the same version with broken projects",
			{ protocolVersion: PROTOCOL_VERSION, projects: { byId: {} } },
			"uiOutdated",
		],
		[
			"a newer host that changed its projects",
			{ protocolVersion: NEWER, projects: { byId: {} }, config: 1 },
			"uiOutdated",
		],
		[
			"an older host that changed its projects",
			{ protocolVersion: OLDER, projects: { byId: {} }, config: 1 },
			"hostOutdated",
		],
		["a newer host", { protocolVersion: NEWER }, "uiOutdated"],
		["an older host", { protocolVersion: OLDER }, "hostOutdated"],
		["no version", {}, "uiOutdated"],
		["a version that is no number", { protocolVersion: String(PROTOCOL_VERSION) }, "uiOutdated"],
		["no object at all", null, "uiOutdated"],
	])("%s", (_name, welcome, expected) => {
		expect(protocolMismatch(welcome)).toBe(expected);
	});
});

describe("server.welcome", () => {
	test.each([
		null,
		{},
		{ protocolVersion: String(PROTOCOL_VERSION) },
		{ protocolVersion: NEWER, config: 1 },
		{ protocolVersion: PROTOCOL_VERSION, projects: { byId: {} } },
	])("the push of %j passes, so the client can prompt", (welcome) => {
		expect(pushFailure("server.welcome", welcome)).toBeNull();
	});

	test("a broken welcome names the field", () => {
		expect(welcomeFailure({ protocolVersion: PROTOCOL_VERSION, projects: { byId: {} } })).toContain(
			"/projects",
		);
	});
});

test("an envelope that is not JSON or not a frame parses to null", () => {
	expect(parseEnvelope("not json")).toBeNull();
	expect(parseEnvelope(JSON.stringify({ hello: 1 }))).toBeNull();
	expect(parseEnvelope(JSON.stringify({ id: "a", ok: true }))).toEqual({ id: "a", ok: true });
});

test("a channel with no schema is unknown", () => {
	expect(pushFailure("from.a.newer.host", {})).toBe("unknown channel");
});

test("a reply problem names the method and the field", () => {
	expect(resultFailure("workspace.diffStats", { added: "1", removed: 0 })).toContain("/added");
	expect(resultProblem("workspace.diffStats", { added: "1", removed: 0 })).toContain(
		"workspace.diffStats replied with a shape its schema refuses: /added",
	);
	expect(resultProblem("workspace.diffStats", { added: 1, removed: 0 })).toBeNull();
});
