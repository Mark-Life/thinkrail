import { expect, test } from "bun:test";
import type { Project, Workspace } from "@thinkrail/contracts";
import { asProjectId, asSessionId, asWorkspaceId } from "@thinkrail/contracts";
import { buildHistoryScope } from "./historyScope";

test("all scope: filter matches any cwd + sessionId", () => {
	const { filter } = buildHistoryScope({ kind: "all" }, [], () => []);

	expect(filter("/some/cwd", asSessionId("session1"))).toBe(true);
	expect(filter("/another/cwd", asSessionId("session2"))).toBe(true);
	expect(filter("", asSessionId(""))).toBe(true);
});

test("chat scope: filter matches only the exact sessionId", () => {
	const { filter } = buildHistoryScope(
		{ kind: "chat", sessionId: asSessionId("target-session") },
		[],
		() => [],
	);

	expect(filter("/some/cwd", asSessionId("target-session"))).toBe(true);
	expect(filter("/some/cwd", asSessionId("other-session"))).toBe(false);
	expect(filter("/another/cwd", asSessionId("target-session"))).toBe(true);
});

test("workspace scope: filter matches the worktreePath of a known workspace", () => {
	const p1: Project = {
		id: asProjectId("p1"),
		name: "project",
		path: "/proj",
		slug: "project",
		lastOpened: 0,
	};
	const ws1: Workspace = {
		id: asWorkspaceId("ws1"),
		projectId: asProjectId("p1"),
		name: "ws1",
		branch: "ws1",
		worktreePath: "/proj/worktrees/ws1",
		baseBranch: "main",
	};
	const ws2: Workspace = {
		id: asWorkspaceId("ws2"),
		projectId: asProjectId("p1"),
		name: "ws2",
		branch: "ws2",
		worktreePath: "/proj/worktrees/ws2",
		baseBranch: "main",
	};

	const { filter } = buildHistoryScope(
		{ kind: "workspace", workspaceId: asWorkspaceId("ws1") },
		[p1],
		(projectId) => (projectId === "p1" ? [ws1, ws2] : []),
	);

	expect(filter("/proj/worktrees/ws1", asSessionId("any-session"))).toBe(true);
	expect(filter("/proj/worktrees/ws2", asSessionId("any-session"))).toBe(false);
	expect(filter("/other/path", asSessionId("any-session"))).toBe(false);
});

test("workspace scope with unknown workspaceId: filter always returns false, even with other workspaces in registry", () => {
	const p1: Project = {
		id: asProjectId("p1"),
		name: "project",
		path: "/proj",
		slug: "project",
		lastOpened: 0,
	};
	const ws1: Workspace = {
		id: asWorkspaceId("ws1"),
		projectId: asProjectId("p1"),
		name: "ws1",
		branch: "ws1",
		worktreePath: "/proj/worktrees/ws1",
		baseBranch: "main",
	};
	const ws2: Workspace = {
		id: asWorkspaceId("ws2"),
		projectId: asProjectId("p1"),
		name: "ws2",
		branch: "ws2",
		worktreePath: "/proj/worktrees/ws2",
		baseBranch: "main",
	};

	const { filter } = buildHistoryScope(
		{ kind: "workspace", workspaceId: asWorkspaceId("unknown-ws") },
		[p1],
		(projectId) => (projectId === "p1" ? [ws1, ws2] : []),
	);

	expect(filter("/proj/worktrees/ws1", asSessionId("any-session"))).toBe(false);
	expect(filter("/proj/worktrees/ws2", asSessionId("any-session"))).toBe(false);
	expect(filter("/", asSessionId("session1"))).toBe(false);
	expect(filter("", asSessionId(""))).toBe(false);
});

test("project scope: filter matches cwds of any workspace in the project", () => {
	const ws1: Workspace = {
		id: asWorkspaceId("ws1"),
		projectId: asProjectId("p1"),
		name: "ws1",
		branch: "ws1",
		worktreePath: "/proj/worktrees/ws1",
		baseBranch: "main",
	};
	const ws2: Workspace = {
		id: asWorkspaceId("ws2"),
		projectId: asProjectId("p1"),
		name: "ws2",
		branch: "ws2",
		worktreePath: "/proj/worktrees/ws2",
		baseBranch: "main",
	};

	const { filter } = buildHistoryScope(
		{ kind: "project", projectId: asProjectId("p1") },
		[{ id: asProjectId("p1"), name: "project", path: "/proj", slug: "project", lastOpened: 0 }],
		(projectId) => (projectId === "p1" ? [ws1, ws2] : []),
	);

	expect(filter("/proj/worktrees/ws1", asSessionId("any-session"))).toBe(true);
	expect(filter("/proj/worktrees/ws2", asSessionId("any-session"))).toBe(true);
	expect(filter("/other/project/worktrees/ws1", asSessionId("any-session"))).toBe(false);
});

test("labels: build a worktreePath → {workspaceId, projectId} map from all projects' workspaces", () => {
	const p1: Project = {
		id: asProjectId("p1"),
		name: "project-1",
		path: "/proj1",
		slug: "project-1",
		lastOpened: 0,
	};
	const p2: Project = {
		id: asProjectId("p2"),
		name: "project-2",
		path: "/proj2",
		slug: "project-2",
		lastOpened: 0,
	};

	const p1ws1: Workspace = {
		id: asWorkspaceId("p1ws1"),
		projectId: asProjectId("p1"),
		name: "ws1",
		branch: "ws1",
		worktreePath: "/proj1/worktrees/ws1",
		baseBranch: "main",
	};
	const p1ws2: Workspace = {
		id: asWorkspaceId("p1ws2"),
		projectId: asProjectId("p1"),
		name: "ws2",
		branch: "ws2",
		worktreePath: "/proj1/worktrees/ws2",
		baseBranch: "main",
	};
	const p2ws1: Workspace = {
		id: asWorkspaceId("p2ws1"),
		projectId: asProjectId("p2"),
		name: "ws1",
		branch: "ws1",
		worktreePath: "/proj2/worktrees/ws1",
		baseBranch: "main",
	};

	const { labels } = buildHistoryScope({ kind: "all" }, [p1, p2], (projectId) => {
		if (projectId === "p1") return [p1ws1, p1ws2];
		if (projectId === "p2") return [p2ws1];
		return [];
	});

	expect(labels("/proj1/worktrees/ws1")).toEqual({
		workspaceId: asWorkspaceId("p1ws1"),
		projectId: asProjectId("p1"),
	});
	expect(labels("/proj1/worktrees/ws2")).toEqual({
		workspaceId: asWorkspaceId("p1ws2"),
		projectId: asProjectId("p1"),
	});
	expect(labels("/proj2/worktrees/ws1")).toEqual({
		workspaceId: asWorkspaceId("p2ws1"),
		projectId: asProjectId("p2"),
	});
	expect(labels("/unknown/path")).toEqual({});
});

test("unknown scope kind: filter always returns false, never throws", () => {
	const { filter } = buildHistoryScope({ kind: "bogus" } as never, [], () => []);

	expect(filter("/some/cwd", asSessionId("session1"))).toBe(false);
	expect(filter("/another/cwd", asSessionId("session2"))).toBe(false);
});
