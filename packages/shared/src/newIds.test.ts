import { expect, test } from "bun:test";
import { parseProjectId, parseWorkspaceId } from "@thinkrail/contracts";
import { newProjectId, newWorkspaceId } from "./newIds";

test.each([
	["project", newProjectId, parseProjectId],
	["workspace", newWorkspaceId, parseWorkspaceId],
] as const)("a new %s id is a distinct v4 UUID its parser accepts", (_kind, make, parse) => {
	const ids = new Set(Array.from({ length: 50 }, () => make()));
	expect(ids.size).toBe(50);
	for (const id of ids) {
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect<string | null>(parse(id)).toBe(id);
	}
});
