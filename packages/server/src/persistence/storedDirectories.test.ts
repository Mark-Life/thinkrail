import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { testProjectId, testWorkspaceId } from "@thinkrail/contracts/test-ids";
import { dataDir, loadProjects, loadWorkspaces, saveProjects, saveWorkspaces } from "./persistence";

let root: string;
const savedDataDir = process.env.THINKRAIL_DATA_DIR;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "trpi-stored-dirs-")));
	process.env.THINKRAIL_DATA_DIR = root;
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
});

function unresolvedSpellings(dir: string): string[] {
	return [`${dir}${sep}.${sep}`, dir.split(sep).join("/")];
}

function project(path: unknown) {
	return { id: "p", name: "repo", path, slug: "repo", lastOpened: 1 };
}

function workspace(worktreePath: unknown) {
	return {
		id: testWorkspaceId("w"),
		projectId: testProjectId("p"),
		kind: "default",
		name: "Default",
		branch: "main",
		worktreePath,
		baseBranch: "main",
	};
}

test("a stored directory loads in the host's resolved spelling, however it was written", () => {
	const dir = join(root, "repo");
	for (const spelling of unresolvedSpellings(dir)) {
		writeFileSync(join(root, "projects.json"), JSON.stringify([project(spelling)]));
		writeFileSync(join(root, "workspaces.json"), JSON.stringify([workspace(spelling)]));

		expect(loadProjects()[0]?.path).toBe(resolve(dir));
		expect(loadWorkspaces()[0]?.worktreePath).toBe(resolve(dir));
	}
});

test("the next save persists the healed spelling", () => {
	const dir = join(root, "repo");
	const [spelling] = unresolvedSpellings(dir);
	writeFileSync(join(root, "projects.json"), JSON.stringify([project(spelling)]));
	writeFileSync(join(root, "workspaces.json"), JSON.stringify([workspace(spelling)]));

	saveProjects(loadProjects());
	saveWorkspaces(loadWorkspaces());

	expect(JSON.parse(readFileSync(join(root, "projects.json"), "utf8"))[0].path).toBe(resolve(dir));
	expect(JSON.parse(readFileSync(join(root, "workspaces.json"), "utf8"))[0].worktreePath).toBe(
		resolve(dir),
	);
});

test("a value that is not an absolute path on this host is left as stored", () => {
	const foreign = process.platform === "win32" ? "relative/repo" : "C:\\Users\\me\\repo";
	writeFileSync(join(root, "projects.json"), JSON.stringify([project(foreign)]));
	writeFileSync(join(root, "workspaces.json"), JSON.stringify([workspace(foreign)]));

	expect(loadProjects().map((stored) => stored.path)).toEqual([foreign]);
	expect(loadWorkspaces()[0]?.worktreePath).toBe(foreign);
});

test("a relative THINKRAIL_DATA_DIR still names one absolute data directory", () => {
	process.env.THINKRAIL_DATA_DIR = relative(process.cwd(), root);
	expect(dataDir()).toBe(root);
});

test("a project with a hand-edited id stays listed", () => {
	const ids = ["0f8fad5b-d9cb-469f-a165-70867728950e", "fixture-project", "hand edited"];
	writeFileSync(
		join(root, "projects.json"),
		JSON.stringify(ids.map((id) => ({ ...project(root), id }))),
	);

	expect(loadProjects().map((entry) => String(entry.id))).toEqual(ids);
});

test("a workspace id stays listed when it is safe in a path, and a path escape drops", () => {
	const kept = ["0f8fad5b-d9cb-469f-a165-70867728950e", "fixture-workspace-scope-one"];
	writeFileSync(
		join(root, "workspaces.json"),
		JSON.stringify(
			[...kept, "../..", "a/b"].map((id) => ({ ...workspace(root), id, projectId: "edited" })),
		),
	);

	expect(loadWorkspaces().map((entry) => String(entry.id))).toEqual(kept);
});
