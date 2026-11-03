import { expect, test } from "bun:test";
import { testProjectId, testSessionId, testWorkspaceId } from "@thinkrail/contracts/test-ids";
import {
	MAIN_LOCATION,
	type NavigationLocation,
	parseFragment,
	serializeLocation,
} from "./location";

test("the codec round-trips all four location kinds", () => {
	const locations: NavigationLocation[] = [
		{ kind: "main" },
		{ kind: "project", projectId: testProjectId("00000000-0000-4000-8000-0000000000a1") },
		{
			kind: "workspace",
			projectId: testProjectId("00000000-0000-4000-8000-0000000000a1"),
			workspaceId: testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		},
		{
			kind: "chat",
			projectId: testProjectId("00000000-0000-4000-8000-0000000000a1"),
			workspaceId: testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
			sessionId: testSessionId("s1"),
		},
	];
	for (const location of locations) {
		expect(parseFragment(serializeLocation(location))).toEqual(location);
	}
});

test("a percent-encoded id decodes before its check", () => {
	expect(parseFragment(`#/v1/projects/${"%30".repeat(8)}-0000-4000-8000-0000000000a1`)).toEqual({
		kind: "project",
		projectId: testProjectId("00000000-0000-4000-8000-0000000000a1"),
	});
});

test("a route with an id its check refuses canonicalizes to main", () => {
	const project = "00000000-0000-4000-8000-0000000000a1";
	const workspace = "00000000-0000-4000-8000-0000000000b1";
	for (const fragment of [
		"#/v1/projects/p1",
		"#/v1/projects/..%2F..%2Fescape",
		`#/v1/projects/${project}/workspaces/w1`,
		`#/v1/projects/${project}/workspaces/..%2Fescape`,
		`#/v1/projects/${project}/workspaces/${workspace}/chats/..%2Fescape`,
		`#/v1/projects/${project}/workspaces/${workspace}/chats/a%2Fb`,
		`#/v1/projects/${project}/workspaces/${workspace}/chats/${"a".repeat(201)}`,
	]) {
		expect(parseFragment(fragment)).toEqual(MAIN_LOCATION);
	}
});

test("a route opens every real session id shape", () => {
	const project = testProjectId("00000000-0000-4000-8000-0000000000a1");
	const workspace = testWorkspaceId("00000000-0000-4000-8000-0000000000b1");
	for (const id of [
		"019a2b3c-4d5e-7f60-8a7b-1c2d3e4f5a6b",
		"0f8fad5b-d9cb-469f-a165-70867728950e",
		"my.custom_id-1",
		"e2e-fixture-deploy-docs",
	]) {
		const location: NavigationLocation = {
			kind: "chat",
			projectId: project,
			workspaceId: workspace,
			sessionId: testSessionId(id),
		};
		expect(parseFragment(serializeLocation(location))).toEqual(location);
	}
});

test("parse accepts the fragment with or without its leading '#'", () => {
	expect(parseFragment("/v1/projects/00000000-0000-4000-8000-0000000000a1")).toEqual({
		kind: "project",
		projectId: testProjectId("00000000-0000-4000-8000-0000000000a1"),
	});
	expect(parseFragment("#/v1/projects/00000000-0000-4000-8000-0000000000a1")).toEqual({
		kind: "project",
		projectId: testProjectId("00000000-0000-4000-8000-0000000000a1"),
	});
});

test("malformed and unknown fragments canonicalize safely to main", () => {
	const invalid = [
		"",
		"#",
		"#/v2/projects/00000000-0000-4000-8000-0000000000a1",
		"#/projects/00000000-0000-4000-8000-0000000000a1",
		"#v1/projects/00000000-0000-4000-8000-0000000000a1",
		"#/v1/project/00000000-0000-4000-8000-0000000000a1",
		"#/v1/projects",
		"#/v1/projects/",
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/",
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces",
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats",
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s1/extra",
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/tabs/t1",
		"#/v1/projects/%GG",
		"#/section-heading",
	];
	for (const fragment of invalid) {
		expect(parseFragment(fragment)).toEqual(MAIN_LOCATION);
	}
	expect(serializeLocation(MAIN_LOCATION)).toBe("#/v1");
});
