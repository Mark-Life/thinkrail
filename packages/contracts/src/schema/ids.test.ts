import { expect, test } from "bun:test";
import * as contracts from "../index";
import {
	newProjectId,
	newWorkspaceId,
	parseProjectId,
	parseSessionId,
	parseWorkspaceId,
} from "./ids";

test.each([
	["project", newProjectId, parseProjectId],
	["workspace", newWorkspaceId, parseWorkspaceId],
] as const)("a new %s id is a distinct v4 UUID its parser accepts", (_kind, make, parse) => {
	const ids = new Set(Array.from({ length: 50 }, () => make()));
	expect(ids.size).toBe(50);
	for (const id of ids) {
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(parse(id)).toBe(id);
	}
});

test.each([
	["project", parseProjectId],
	["workspace", parseWorkspaceId],
	["session", parseSessionId],
] as const)("the %s parser answers null for a value that is not a string", (_kind, parse) => {
	for (const value of [undefined, null, 1, {}, []]) expect(parse(value)).toBeNull();
});

test("the package root does not offer the test-only id makers", () => {
	expect(
		Object.keys(contracts).filter((name) => /^test(?:Project|Workspace|Session)Id$/.test(name)),
	).toEqual([]);
});
