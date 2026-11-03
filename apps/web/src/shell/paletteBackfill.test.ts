import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
	Project,
	ProjectId,
	SessionId,
	SessionStateRecord,
	Workspace,
	WorkspaceId,
} from "@thinkrail/contracts";
import { asProjectId, asSessionId, asWorkspaceId } from "@thinkrail/contracts";
import { useAppStore } from "../store";
import {
	createPaletteBackfill,
	mergeProjectWorkspaces,
	projectNeedsWorkspaceList,
	projectsNeedingWorkspaceLists,
} from "./paletteBackfill";

const project = (id: string): Project => ({
	id: asProjectId(id),
	name: id,
	path: `/repos/${id}`,
	slug: id,
	lastOpened: 0,
});

const workspace = (id: string, projectId: ProjectId, name = id): Workspace => ({
	id: asWorkspaceId(id),
	projectId,
	name,
	branch: name,
	baseBranch: "main",
	worktreePath: `/worktrees/${id}`,
});

const record = (
	sessionId: SessionId,
	workspaceId: WorkspaceId,
	projectId: ProjectId,
): SessionStateRecord => ({
	sessionId,
	workspaceId,
	projectId,
	state: {
		execution: "idle",
		runId: null,
		needsInput: null,
		completion: null,
		completionUnread: false,
		queuedCount: 0,
		backgroundWork: false,
	},
	title: "",
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const initial = useAppStore.getInitialState();

beforeEach(() => useAppStore.setState(initial, true));
afterEach(() => useAppStore.setState(initial, true));

describe("project membership refresh", () => {
	test("a project is listed when it has no list, or when a reported workspace is missing from it", () => {
		useAppStore.setState({
			projects: [project("p1"), project("p2"), project("p3")],
			workspaces: {
				p2: [workspace("w2", asProjectId("p2"))],
				p3: [workspace("w3", asProjectId("p3"))],
			},
			sessionStateByWorkspace: {
				w2: { s2: record(asSessionId("s2"), asWorkspaceId("w2"), asProjectId("p2")) },
				"w-new": { s3: record(asSessionId("s3"), asWorkspaceId("w-new"), asProjectId("p3")) },
				"w-gone": { s4: record(asSessionId("s4"), asWorkspaceId("w-gone"), asProjectId("p2")) },
			},
			removedWorkspaceIds: { "w-gone": true },
		});
		const state = useAppStore.getState();
		expect(projectNeedsWorkspaceList(state, asProjectId("p1"))).toBe(true);
		expect(projectNeedsWorkspaceList(state, asProjectId("p2"))).toBe(false);
		expect(projectNeedsWorkspaceList(state, asProjectId("p3"))).toBe(true);
		expect(projectNeedsWorkspaceList(state, asProjectId("closed"))).toBe(false);
		expect(projectsNeedingWorkspaceLists(state)).toEqual(["p1", "p3"]);
	});

	test("a refresh keeps the host's order, keeps rows that arrived meanwhile, and never replaces them", () => {
		const fresh = workspace("w1", asProjectId("p1"), "renamed by a push");
		const pushed = workspace("w9", asProjectId("p1"));
		useAppStore.setState({
			projects: [project("p1")],
			workspaces: { p1: [fresh, workspace("w3", asProjectId("p1")), pushed] },
		});
		mergeProjectWorkspaces(asProjectId("p1"), [
			workspace("w1", asProjectId("p1"), "stale name"),
			workspace("w2", asProjectId("p1")),
			workspace("w3", asProjectId("p1")),
		]);
		const rows = useAppStore.getState().workspaces.p1 ?? [];
		expect(rows.map((row) => row.id)).toEqual([
			asWorkspaceId("w1"),
			asWorkspaceId("w2"),
			asWorkspaceId("w3"),
			asWorkspaceId("w9"),
		]);
		expect(rows[0]).toBe(fresh);

		mergeProjectWorkspaces(asProjectId("p9"), [workspace("w9", asProjectId("p9"))]);
		expect(useAppStore.getState().workspaces.p9).toBeUndefined();
	});
});

describe("the palette backfill against deferred host replies", () => {
	function deferredSources() {
		const calls: { projectId: ProjectId; resolve: (rows: Workspace[]) => void }[] = [];
		const backfill = createPaletteBackfill({
			listWorkspaces: (projectId) =>
				new Promise((resolve) => {
					calls.push({ projectId, resolve });
				}),
			concurrency: 4,
		});
		return { calls, backfill };
	}

	function connected() {
		useAppStore.setState({
			status: "connected",
			connectionGeneration: 1,
			welcomeGeneration: 1,
			projects: [project("p1")],
		});
	}

	test("nothing is asked before the connection is up, and the welcome asks once", () => {
		useAppStore.setState({ status: "disconnected", projects: [project("p1")] });
		const { calls, backfill } = deferredSources();
		const stop = backfill.watch();
		expect(calls).toHaveLength(0);
		useAppStore.setState({ status: "connected", connectionGeneration: 1 });
		expect(calls).toHaveLength(0);
		useAppStore.setState({ welcomeGeneration: 1 });
		expect(calls.map((call) => call.projectId)).toEqual([asProjectId("p1")]);
		stop();
	});

	test("a listed project is merged and not asked again", async () => {
		connected();
		const { calls, backfill } = deferredSources();
		const stop = backfill.watch();
		calls[0]?.resolve([workspace("w1", asProjectId("p1"))]);
		await settle();
		expect(useAppStore.getState().workspaces.p1?.map((row) => row.id)).toEqual([
			asWorkspaceId("w1"),
		]);
		useAppStore.setState({ welcomeGeneration: 2 });
		expect(calls).toHaveLength(1);
		stop();
	});

	test("a reply from an earlier connection is dropped and the project is asked again after the welcome", async () => {
		connected();
		const { calls, backfill } = deferredSources();
		const stop = backfill.watch();
		useAppStore.setState({ connectionGeneration: 2, welcomeGeneration: 2 });
		calls[0]?.resolve([workspace("w-stale", asProjectId("p1"))]);
		await settle();
		expect(useAppStore.getState().workspaces.p1).toBeUndefined();
		expect(calls).toHaveLength(2);
		calls[1]?.resolve([workspace("w1", asProjectId("p1"))]);
		await settle();
		expect(useAppStore.getState().workspaces.p1?.map((row) => row.id)).toEqual([
			asWorkspaceId("w1"),
		]);
		stop();
	});

	test("a workspace a peer created while away makes its project listed again", async () => {
		connected();
		useAppStore.setState({ workspaces: { p1: [workspace("w1", asProjectId("p1"))] } });
		const { calls, backfill } = deferredSources();
		const stop = backfill.watch();
		expect(calls).toHaveLength(0);
		useAppStore.setState({
			sessionStateByWorkspace: {
				w2: { s2: record(asSessionId("s2"), asWorkspaceId("w2"), asProjectId("p1")) },
			},
		});
		expect(calls.map((call) => call.projectId)).toEqual([asProjectId("p1")]);
		stop();
		useAppStore.setState({ welcomeGeneration: 3 });
		expect(calls).toHaveLength(1);
	});
});
