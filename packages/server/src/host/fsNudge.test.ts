import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectId, Workspace, WorkspaceFsChangedPayload } from "@thinkrail/contracts";
import { testProjectId, testWorkspaceId } from "@thinkrail/contracts/test-ids";
import { nudgeBaseRefWorkspaces, setFsNudgePublisher } from "./fsNudge";

let dataDir: string;
const savedDataDir = process.env.THINKRAIL_DATA_DIR;

function ws(id: string, projectId: ProjectId, extra: Partial<Workspace>): Workspace {
	return {
		id: testWorkspaceId(id),
		projectId,
		name: id,
		branch: id,
		worktreePath: `/tmp/${id}`,
		baseBranch: "main",
		...extra,
	};
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "trpi-fsnudge-test-"));
	process.env.THINKRAIL_DATA_DIR = dataDir;
	writeFileSync(
		join(dataDir, "workspaces.json"),
		JSON.stringify([
			ws("w-base", testProjectId("p1"), { baseBranch: "origin/main" }),
			ws("w-repointed", testProjectId("p1"), { baseBranch: "main", diffBase: "origin/main" }),
			ws("w-away", testProjectId("p1"), { baseBranch: "origin/main", diffBase: "release" }),
			ws("w-other-ref", testProjectId("p1"), {}),
			ws("w-other-project", testProjectId("p2"), { baseBranch: "origin/main" }),
		]),
	);
});

afterEach(() => {
	setFsNudgePublisher(null);
	rmSync(dataDir, { recursive: true, force: true });
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
});

test("nudges exactly the project's workspaces whose diff base is the moved ref, as pathless frames", () => {
	const frames: WorkspaceFsChangedPayload[] = [];
	setFsNudgePublisher((payload) => frames.push(payload));

	nudgeBaseRefWorkspaces(testProjectId("p1"), "origin/main");

	expect(frames).toEqual([
		{ workspaceId: testWorkspaceId("w-base"), paths: [], truncated: false, skillChange: "none" },
		{
			workspaceId: testWorkspaceId("w-repointed"),
			paths: [],
			truncated: false,
			skillChange: "none",
		},
	]);
});

test("without an installed publisher the nudge is a silent no-op (unit-test / teardown state)", () => {
	setFsNudgePublisher(null);
	expect(() => nudgeBaseRefWorkspaces(testProjectId("p1"), "origin/main")).not.toThrow();
});
