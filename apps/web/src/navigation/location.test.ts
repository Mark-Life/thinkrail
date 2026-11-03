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
		{ kind: "project", projectId: testProjectId("p1") },
		{ kind: "workspace", projectId: testProjectId("p1"), workspaceId: testWorkspaceId("w1") },
		{
			kind: "chat",
			projectId: testProjectId("p1"),
			workspaceId: testWorkspaceId("w1"),
			sessionId: testSessionId("s1"),
		},
	];
	for (const location of locations) {
		expect(parseFragment(serializeLocation(location))).toEqual(location);
	}
});

test("ids that need encoding survive the round trip as single path segments", () => {
	const location: NavigationLocation = {
		kind: "chat",
		projectId: testProjectId("p/with slash"),
		workspaceId: testWorkspaceId("w#hash?q"),
		sessionId: testSessionId("s%25already"),
	};
	const fragment = serializeLocation(location);
	expect(fragment.split("/")).toHaveLength(8);
	expect(parseFragment(fragment)).toEqual(location);
});

test("parse accepts the fragment with or without its leading '#'", () => {
	expect(parseFragment("/v1/projects/p1")).toEqual({
		kind: "project",
		projectId: testProjectId("p1"),
	});
	expect(parseFragment("#/v1/projects/p1")).toEqual({
		kind: "project",
		projectId: testProjectId("p1"),
	});
});

test("malformed and unknown fragments canonicalize safely to main", () => {
	const invalid = [
		"",
		"#",
		"#/v2/projects/p1",
		"#/projects/p1",
		"#v1/projects/p1",
		"#/v1/project/p1",
		"#/v1/projects",
		"#/v1/projects/",
		"#/v1/projects/p1/",
		"#/v1/projects/p1/workspaces",
		"#/v1/projects/p1/workspaces/w1/chats",
		"#/v1/projects/p1/workspaces/w1/chats/s1/extra",
		"#/v1/projects/p1/tabs/t1",
		"#/v1/projects/%GG",
		"#/section-heading",
	];
	for (const fragment of invalid) {
		expect(parseFragment(fragment)).toEqual(MAIN_LOCATION);
	}
	expect(serializeLocation(MAIN_LOCATION)).toBe("#/v1");
});
