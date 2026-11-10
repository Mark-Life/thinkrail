import { describe, expect, test } from "bun:test";
import type { Schema } from "@earendil-works/pi-schema";
import * as contracts from "../index";
import { WS_CHANNEL_SCHEMAS } from "./channels";
import { WsRequestFrame } from "./envelope";
import {
	ProjectId,
	parseProjectId,
	parseSessionId,
	parseStoredProjectId,
	parseStoredSessionId,
	parseStoredWorkspaceId,
	parseWorkspaceId,
	SessionId,
	StoredProjectId,
	StoredSessionId,
	StoredWorkspaceId,
	WorkspaceId,
} from "./ids";
import { WS_METHOD_SCHEMAS } from "./methods";

const UUID_V4 = "0f8fad5b-d9cb-469f-a165-70867728950e";
const UUID_V7 = "019a2b3c-4d5e-7f60-8a7b-1c2d3e4f5a6b";
const OLD_SCOPE_FOLDER = "fixture-workspace-scope-one";
const PATH_ESCAPES = [
	"..",
	"../escape",
	"../../etc/passwd",
	"a/../b",
	"a/b",
	"a\\b",
	"..\\escape",
	"/absolute",
	"C:\\Windows",
	"%2e%2e%2f",
	"a\u0000b",
	".hidden",
	"trailing.",
];

test.each([
	["project", parseProjectId],
	["workspace", parseWorkspaceId],
	["session", parseSessionId],
] as const)("the %s parser answers null for a value that is not a string", (_kind, parse) => {
	for (const value of [undefined, null, 1, {}, []]) expect(parse(value)).toBeNull();
});

describe("project and workspace ids that come from outside", () => {
	test.each([
		["project", parseProjectId],
		["workspace", parseWorkspaceId],
	] as const)("the %s parser accepts a UUID and refuses the rest", (_kind, parse) => {
		for (const id of [UUID_V4, UUID_V7]) expect<string | null>(parse(id)).toBe(id);
		for (const id of [
			"",
			"w1",
			"fixture-project",
			OLD_SCOPE_FOLDER,
			UUID_V4.toUpperCase(),
			`${UUID_V4}\n`,
			`${UUID_V4}/..`,
			...PATH_ESCAPES,
		])
			expect(parse(id)).toBeNull();
	});
});

describe("session ids that come from outside", () => {
	test.each([
		["v7, a new pi session", UUID_V7],
		["v4, pi before 0.67.1", UUID_V4],
		["a pi --session-id value", "my.custom_id-1"],
		["one character", "a"],
		["the e2e fixture", "e2e-fixture-deploy-docs"],
		["the history fixture", `sess-${UUID_V4}`],
		["the length limit", "a".repeat(200)],
	])("accepts %s", (_shape, id) => {
		expect<string | null>(parseSessionId(id)).toBe(id);
	});

	test("refuses a path escape, unsafe characters and an id over the limit", () => {
		for (const id of ["", "a b", "a:b", "probe:mcplogin_1", "a".repeat(201), ...PATH_ESCAPES])
			expect(parseSessionId(id)).toBeNull();
	});
});

describe("ids read back from disk", () => {
	test("a project id stays readable unless it is empty", () => {
		for (const id of [UUID_V4, "fixture-project", "hand edited", "../escape"])
			expect<string | null>(parseStoredProjectId(id)).toBe(id);
		expect(parseStoredProjectId("")).toBeNull();
	});

	test("a workspace id stays readable when it is safe in a path", () => {
		for (const id of [UUID_V4, OLD_SCOPE_FOLDER, "w1"])
			expect<string | null>(parseStoredWorkspaceId(id)).toBe(id);
		for (const id of ["", ...PATH_ESCAPES]) expect(parseStoredWorkspaceId(id)).toBeNull();
	});

	test("a session id stays readable in any form pi accepts in a file", () => {
		for (const id of [UUID_V7, "", "edited header", "probe:mcplogin_1", "../escape"])
			expect<string | null>(parseStoredSessionId(id)).toBe(id);
		expect(parseStoredSessionId(1)).toBeNull();
	});
});

describe("which id schema each direction of the wire uses", () => {
	function idsIn(root: unknown, kinds: ReadonlyMap<unknown, string>, path: string): string[] {
		const kind = kinds.get(root);
		if (kind !== undefined) return [`${path}: ${kind}`];
		if (typeof root !== "object" || root === null) return [];
		return Object.entries(root).flatMap(([key, child]) => idsIn(child, kinds, `${path}.${key}`));
	}

	const checked = new Map<Schema<string>, string>([
		[ProjectId, "ProjectId"],
		[WorkspaceId, "WorkspaceId"],
		[SessionId, "SessionId"],
	]);
	const stored = new Map<Schema<string>, string>([
		[StoredProjectId, "StoredProjectId"],
		[StoredWorkspaceId, "StoredWorkspaceId"],
		[StoredSessionId, "StoredSessionId"],
	]);
	const methods = Object.entries(WS_METHOD_SCHEMAS);

	test("every request field holds a checked id", () => {
		expect(
			methods.flatMap(([method, schema]) => idsIn(schema.params, stored, `${method}.params`)),
		).toEqual([]);
		expect(idsIn(WsRequestFrame, stored, "WsRequestFrame")).toEqual([]);
		expect(
			methods.flatMap(([method, schema]) => idsIn(schema.params, checked, `${method}.params`))
				.length,
		).toBeGreaterThan(100);
	});

	test("every reply and push holds an id that a disk read can produce", () => {
		expect(
			methods.flatMap(([method, schema]) => idsIn(schema.result, checked, `${method}.result`)),
		).toEqual([]);
		expect(
			Object.entries(WS_CHANNEL_SCHEMAS).flatMap(([channel, schema]) =>
				idsIn(schema, checked, channel),
			),
		).toEqual([]);
	});
});

test("the package root does not offer the test-only id makers", () => {
	expect(
		Object.keys(contracts).filter((name) => /^test(?:Project|Workspace|Session)Id$/.test(name)),
	).toEqual([]);
});
