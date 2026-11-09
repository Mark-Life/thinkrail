import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Project, SessionId, SessionStateRecord, Workspace } from "@thinkrail/contracts";
import { testProjectId, testSessionId, testWorkspaceId } from "@thinkrail/contracts/test-ids";
import type { LoginState } from "../auth";
import { useAppStore } from "../store";
import * as wireTransport from "./wireTransport";
import { applyWorkspaceListRefresh, mergeSessionStateRecords } from "./wireTransport";

function record(sessionId: SessionId, completionId: string): SessionStateRecord {
	return {
		sessionId,
		workspaceId: testWorkspaceId("workspace"),
		projectId: testProjectId("project"),
		state: {
			execution: "idle",
			runId: `run:${sessionId}`,
			needsInput: null,
			completion: { completionId, outcome: "succeeded" },
			completionUnread: true,
			queuedCount: 0,
			backgroundWork: false,
		},
	};
}

test("buffered state replaces its stale snapshot row before activation binding", () => {
	const other = record(testSessionId("other"), "completion:other");
	expect(
		mergeSessionStateRecords(
			[record(testSessionId("target"), "completion:old"), other],
			[
				record(testSessionId("target"), "completion:newer"),
				record(testSessionId("target"), "completion:latest"),
			],
		),
	).toEqual([record(testSessionId("target"), "completion:latest"), other]);
});

describe("the reconnect workspace list refresh", () => {
	const project = (id: string): Project => ({
		id: testProjectId(id),
		name: id,
		path: `/repos/${id}`,
		slug: id,
		lastOpened: 0,
	});
	const workspace = (id: string, name = id): Workspace => ({
		id: testWorkspaceId(id),
		projectId: testProjectId("p1"),
		name,
		branch: id,
		baseBranch: "main",
		worktreePath: `/worktrees/${id}`,
	});
	const initial = useAppStore.getInitialState();
	beforeEach(() => useAppStore.setState(initial, true));
	afterEach(() => useAppStore.setState(initial, true));

	test("retires rows the host no longer lists and refreshes the ones it still does", () => {
		useAppStore.setState({
			projects: [project("p1")],
			workspaces: { p1: [workspace("w1"), workspace("w2"), workspace("w3")] },
		});
		applyWorkspaceListRefresh(
			testProjectId("p1"),
			[testWorkspaceId("w1"), testWorkspaceId("w2"), testWorkspaceId("w3")],
			[workspace("w1", "renamed"), workspace("w3")],
		);
		const state = useAppStore.getState();
		expect(state.workspaces.p1?.map((row) => [row.id, row.name])).toEqual([
			["w1", "renamed"],
			["w3", "w3"],
		]);
		expect(state.removedWorkspaceIds.w2).toBe(true);
	});

	test("keeps rows that arrived after the read was sent and adds none of its own", () => {
		useAppStore.setState({
			projects: [project("p1")],
			workspaces: { p1: [workspace("w1"), workspace("w-pushed")] },
		});
		applyWorkspaceListRefresh(
			testProjectId("p1"),
			[testWorkspaceId("w1")],
			[workspace("w1"), workspace("w-unknown")],
		);
		const state = useAppStore.getState();
		expect(state.workspaces.p1?.map((row) => row.id)).toEqual([
			testWorkspaceId("w1"),
			testWorkspaceId("w-pushed"),
		]);
		expect(state.removedWorkspaceIds["w-pushed"]).toBeUndefined();
	});

	test("ignores a reply for a project that closed meanwhile", () => {
		useAppStore.setState({ projects: [], workspaces: { p1: [workspace("w1")] } });
		applyWorkspaceListRefresh(testProjectId("p1"), [testWorkspaceId("w1")], []);
		const state = useAppStore.getState();
		expect(state.workspaces.p1?.map((row) => row.id)).toEqual([testWorkspaceId("w1")]);
		expect(state.removedWorkspaceIds.w1).toBeUndefined();
	});

	test("cancels the MCP login of a retired workspace like a live removal does", () => {
		const requests: [string, unknown][] = [];
		const transport = {
			request: (method: string, params: unknown) => {
				requests.push([method, params]);
				return Promise.resolve({ ok: true });
			},
		} as unknown as ReturnType<typeof wireTransport.getTransport>;
		const spy = spyOn(wireTransport, "getTransport").mockReturnValue(transport);
		try {
			const login: LoginState = {
				loginId: "login_1",
				providerId: "mcp",
				target: { kind: "mcp", workspaceId: testWorkspaceId("w2"), serverName: "docs" },
				status: "active",
			};
			useAppStore.setState({
				projects: [project("p1")],
				workspaces: { p1: [workspace("w1"), workspace("w2")] },
				activeLogin: login,
			});
			applyWorkspaceListRefresh(
				testProjectId("p1"),
				[testWorkspaceId("w1"), testWorkspaceId("w2")],
				[workspace("w1")],
			);
			expect(useAppStore.getState().activeLogin).toBeNull();
			expect(requests).toEqual([["provider.loginCancel", { loginId: "login_1" }]]);
		} finally {
			spy.mockRestore();
		}
	});
});
