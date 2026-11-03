import { describe, expect, test } from "bun:test";
import type { ProjectId, SessionId, WorkspaceId } from "@thinkrail/contracts";
import {
	MODEL_PICKER_PROTOCOL_VERSION,
	type Project,
	SEARCH_PROTOCOL_VERSION,
	type SessionState,
	type SessionStateRecord,
	type WireModel,
	type Workspace,
} from "@thinkrail/contracts";
import { testProjectId, testSessionId, testWorkspaceId } from "@thinkrail/contracts/test-ids";
import { applyLocale, currentTranslator } from "@thinkrail/locales/react";
import type { WorkspaceLayoutDocument } from "../shell/layout";
import { type EditorTab, EMPTY_RUNTIME } from "./appStore";
import {
	fsChangedPaths,
	isConnectedGeneration,
	isDefaultWorkspace,
	isExternalWorkspace,
	isUserOwnedWorkspace,
	matchesWorktreePath,
	selectActiveEditorTab,
	selectActiveWorkspace,
	selectActiveWorkspaceProjectId,
	selectAgentReviewCommentCount,
	selectAttentionCenterResourceCacheKey,
	selectAttentionCenterResourceReady,
	selectAttentionCenterTab,
	selectCanRenameChat,
	selectCatalogModel,
	selectChatAttended,
	selectChatFirstPrompt,
	selectChatTitle,
	selectCompletionMarkedUnread,
	selectContextProject,
	selectFileChangeSince,
	selectHistoryTarget,
	selectHostReachable,
	selectHostSearchAvailable,
	selectHostSearchReady,
	selectKnownChatLocation,
	selectKnownChatTitle,
	selectLayoutResourcePlacement,
	selectLayoutTabPlaced,
	selectLayoutTabPlacement,
	selectProjectIsRunning,
	selectProjectNeedsAttention,
	selectReadyCompletionAck,
	selectSkillsStale,
	selectSupportsModelPicker,
	selectUnnamedChatFirstPrompts,
	selectWorkspaceIsRunning,
	selectWorkspaceNeedsAttention,
	selectWorkspaceReadAction,
	specPathMatcher,
	workspaceName,
} from "./selectors";

const projectOne: Project = {
	id: testProjectId("p1"),
	name: "One",
	path: "/one",
	slug: "one",
	lastOpened: 1,
};
const projectTwo: Project = {
	id: testProjectId("p2"),
	name: "Two",
	path: "/two",
	slug: "two",
	lastOpened: 2,
};
const projects = [projectOne, projectTwo];
const workspace: Workspace = {
	id: testWorkspaceId("w2"),
	projectId: testProjectId("p2"),
	name: "Second workspace",
	branch: "second-workspace",
	worktreePath: "/two/workspace",
	baseBranch: "main",
};
const workspaces = { p1: [], p2: [workspace] };

test("connection generations reject stale or disconnected read settlements", () => {
	expect(isConnectedGeneration({ status: "connected", connectionGeneration: 4 }, 4)).toBe(true);
	expect(isConnectedGeneration({ status: "connected", connectionGeneration: 5 }, 4)).toBe(false);
	expect(isConnectedGeneration({ status: "disconnected", connectionGeneration: 4 }, 4)).toBe(false);
});

test("host search stays available across a reconnect, but asks only a reachable host that serves it", () => {
	const state = (
		status: string,
		protocolVersion: number | null,
		welcomeProtocolVersion: number | null,
	) => ({
		status,
		protocolVersion,
		welcomeProtocolVersion,
		welcomeGeneration: welcomeProtocolVersion === null ? 0 : 1,
	});
	const current = state("connected", SEARCH_PROTOCOL_VERSION, SEARCH_PROTOCOL_VERSION);
	const blip = state("connecting", null, SEARCH_PROTOCOL_VERSION);
	const older = state("connected", SEARCH_PROTOCOL_VERSION - 1, SEARCH_PROTOCOL_VERSION - 1);
	expect([current, blip, older].map(selectHostSearchAvailable)).toEqual([true, true, false]);
	expect([current, blip, older].map(selectHostReachable)).toEqual([true, false, true]);
	expect([current, blip, older].map(selectHostSearchReady)).toEqual([true, false, false]);
	expect(selectHostReachable(state("connected", null, null))).toBe(false);
});

test("chat rename capability follows the host protocol snapshot", () => {
	expect(selectCanRenameChat({ protocolVersion: 66 })).toBe(true);
	expect(selectCanRenameChat({ protocolVersion: 65 })).toBe(false);
	expect(selectCanRenameChat({ protocolVersion: null })).toBe(false);
});

test("normalized rail flags keep attention binary and working orthogonal", () => {
	const record = (
		sessionId: SessionId,
		projectId: ProjectId,
		workspaceId: WorkspaceId,
		state: SessionStateRecord["state"],
	): SessionStateRecord => ({ sessionId, projectId, workspaceId, state });
	const quiet = {
		execution: "idle" as const,
		runId: null,
		needsInput: null,
		completion: null,
		completionUnread: false,
		queuedCount: 0,
		backgroundWork: false,
	};
	const working = { ...quiet, execution: "running" as const, runId: "run-working" };
	const delegating = { ...quiet, runId: "run-delegating", backgroundWork: true };
	const finished = {
		...quiet,
		runId: "run-finished",
		completion: { completionId: "done", outcome: "succeeded" as const },
		completionUnread: true,
	};
	const needsInput = {
		...working,
		needsInput: { interactionId: "tool:q1", kind: "tool-response" as const, toolCallId: "q1" },
	};
	const state = {
		sessionStateByWorkspace: {
			w1: {
				a: record(testSessionId("a"), testProjectId("p1"), testWorkspaceId("w1"), working),
				b: record(testSessionId("b"), testProjectId("p1"), testWorkspaceId("w1"), finished),
			},
			w2: { c: record(testSessionId("c"), testProjectId("p1"), testWorkspaceId("w2"), needsInput) },
			w3: { d: record(testSessionId("d"), testProjectId("p2"), testWorkspaceId("w3"), quiet) },
			w4: { e: record(testSessionId("e"), testProjectId("p3"), testWorkspaceId("w4"), delegating) },
		},
	};
	expect(selectWorkspaceNeedsAttention(state, testWorkspaceId("w1"))).toBe(true);
	expect(selectWorkspaceIsRunning(state, testWorkspaceId("w1"))).toBe(true);
	expect(selectWorkspaceNeedsAttention(state, testWorkspaceId("w2"))).toBe(true);
	expect(selectWorkspaceIsRunning(state, testWorkspaceId("w2"))).toBe(true);
	expect(selectProjectNeedsAttention(state, testProjectId("p1"))).toBe(true);
	expect(selectProjectIsRunning(state, testProjectId("p1"))).toBe(true);
	expect(selectProjectNeedsAttention(state, testProjectId("p2"))).toBe(false);
	expect(selectProjectIsRunning(state, testProjectId("p2"))).toBe(false);
	expect(selectWorkspaceIsRunning(state, testWorkspaceId("w4"))).toBe(true);
	expect(selectProjectIsRunning(state, testProjectId("p3"))).toBe(true);
});

test("the workspace read action offers read over unread and hides with nothing to relight", () => {
	const base = {
		execution: "idle" as const,
		runId: "u1",
		needsInput: null,
		queuedCount: 0,
		backgroundWork: false,
	};
	const finished = (id: string, unread: boolean) => ({
		...base,
		completion: { completionId: `completion:${id}`, outcome: "succeeded" as const },
		completionUnread: unread,
	});
	const cancelled = {
		...base,
		completion: { completionId: "interrupted:u1", outcome: "cancelled" as const },
		completionUnread: false,
	};
	const row = (sessionId: SessionId, state: SessionState) => ({
		sessionId,
		workspaceId: testWorkspaceId("w"),
		projectId: testProjectId("p"),
		state,
	});
	const action = (...states: SessionState[]) =>
		selectWorkspaceReadAction(
			{
				sessionStateByWorkspace: {
					w: Object.fromEntries(states.map((st, i) => [`s${i}`, row(testSessionId(`s${i}`), st)])),
				},
			},
			testWorkspaceId("w"),
		);
	expect(action(finished("a", false))).toBe("markUnread");
	expect(action(finished("a", false), finished("b", true))).toBe("markRead");
	expect(action(cancelled)).toBeNull();
	expect(action({ ...finished("a", false), backgroundWork: true })).toBeNull();
	expect(action({ ...finished("a", false), execution: "running" })).toBeNull();
	expect(action()).toBeNull();
});

test("a result counts as marked unread only for the exact completion this window relit", () => {
	const state = {
		execution: "idle" as const,
		runId: "u1",
		needsInput: null,
		completion: { completionId: "completion:a", outcome: "succeeded" as const },
		completionUnread: true,
		queuedCount: 0,
		backgroundWork: false,
	};
	const record = {
		sessionId: testSessionId("s"),
		workspaceId: testWorkspaceId("w"),
		projectId: testProjectId("p"),
		state,
	};
	const none = { markingUnreadWorkspaces: {}, markedUnreadBySession: {} };
	const mark = { workspaceId: testWorkspaceId("w"), completionId: "completion:a", held: false };
	expect(selectCompletionMarkedUnread(none, record)).toBe(false);
	const pending = (candidates: Record<string, string>) => ({
		...none,
		markingUnreadWorkspaces: { w: { candidates, attendedSessionId: null } },
	});
	expect(selectCompletionMarkedUnread(pending({ s: "completion:a" }), record)).toBe(true);
	expect(selectCompletionMarkedUnread(pending({ s: "completion:old" }), record)).toBe(false);
	expect(selectCompletionMarkedUnread(pending({ other: "completion:a" }), record)).toBe(false);
	expect(
		selectCompletionMarkedUnread({ ...none, markedUnreadBySession: { s: mark } }, record),
	).toBe(true);
	expect(
		selectCompletionMarkedUnread({ ...none, markedUnreadBySession: { s: mark } }, record, {
			heldOnly: true,
		}),
	).toBe(false);
	expect(
		selectCompletionMarkedUnread(
			{ ...none, markedUnreadBySession: { s: { ...mark, completionId: "completion:old" } } },
			record,
		),
	).toBe(false);
	expect(
		selectCompletionMarkedUnread(
			{ ...none, markedUnreadBySession: { s: mark } },
			{ ...record, state: { ...state, completionUnread: false } },
		),
	).toBe(false);
});

test("completion acknowledgement requires the exact current result to have rendered", () => {
	const completion = { completionId: "completion:a1", outcome: "succeeded" as const };
	const hostState = {
		execution: "idle" as const,
		runId: "u1",
		needsInput: null,
		completion,
		completionUnread: true,
		queuedCount: 0,
		backgroundWork: false,
	};
	const state = {
		status: "connected",
		connectionGeneration: 4,
		sessionStateByWorkspace: {
			w1: {
				s1: {
					sessionId: testSessionId("s1"),
					workspaceId: testWorkspaceId("w1"),
					projectId: testProjectId("p1"),
					state: hostState,
				},
			},
		},
		sessions: {
			s1: { ...EMPTY_RUNTIME, hostState, syncedConnectionGeneration: 4 },
		},
		renderedCompletionBySession: { s1: completion.completionId },
		markingUnreadWorkspaces: {},
		markedUnreadBySession: {},
	};
	expect(selectReadyCompletionAck(state, testWorkspaceId("w1"), testSessionId("s1"))).toBe(
		completion.completionId,
	);
	expect(
		selectReadyCompletionAck(
			{
				...state,
				markingUnreadWorkspaces: {
					w1: { candidates: { s1: completion.completionId }, attendedSessionId: null },
				},
			},
			testWorkspaceId("w1"),
			testSessionId("s1"),
		),
	).toBeNull();
	expect(
		selectReadyCompletionAck(
			{
				...state,
				markingUnreadWorkspaces: { w1: { candidates: { s1: "older" }, attendedSessionId: null } },
			},
			testWorkspaceId("w1"),
			testSessionId("s1"),
		),
	).toBe(completion.completionId);
	const mark = {
		workspaceId: testWorkspaceId("w1"),
		completionId: completion.completionId,
		held: true,
	};
	expect(
		selectReadyCompletionAck(
			{ ...state, markedUnreadBySession: { s1: mark } },
			testWorkspaceId("w1"),
			testSessionId("s1"),
		),
	).toBeNull();
	expect(
		selectReadyCompletionAck(
			{ ...state, markedUnreadBySession: { s1: { ...mark, held: false } } },
			testWorkspaceId("w1"),
			testSessionId("s1"),
		),
	).toBe(completion.completionId);
	expect(
		selectReadyCompletionAck(
			{ ...state, markedUnreadBySession: { s1: { ...mark, completionId: "older" } } },
			testWorkspaceId("w1"),
			testSessionId("s1"),
		),
	).toBe(completion.completionId);
	expect(
		selectReadyCompletionAck(
			{ ...state, renderedCompletionBySession: { s1: "older" } },
			testWorkspaceId("w1"),
			testSessionId("s1"),
		),
	).toBeNull();
	expect(
		selectReadyCompletionAck(
			{ ...state, status: "disconnected" },
			testWorkspaceId("w1"),
			testSessionId("s1"),
		),
	).toBeNull();
	expect(
		selectReadyCompletionAck(
			{ ...state, sessions: { s1: { ...state.sessions.s1, syncedConnectionGeneration: 3 } } },
			testWorkspaceId("w1"),
			testSessionId("s1"),
		),
	).toBeNull();
	const read = { ...hostState, completionUnread: false };
	expect(
		selectReadyCompletionAck(
			{
				...state,
				sessionStateByWorkspace: {
					w1: {
						s1: {
							sessionId: testSessionId("s1"),
							workspaceId: testWorkspaceId("w1"),
							projectId: testProjectId("p1"),
							state: read,
						},
					},
				},
			},
			testWorkspaceId("w1"),
			testSessionId("s1"),
		),
	).toBeNull();
});

test("a chat is attended only as the selected tab of the last-focused center group in the active workspace", () => {
	const chat = (id: string, sessionId: SessionId) => ({
		kind: "chat" as const,
		id,
		name: id,
		sessionId,
	});
	const state = {
		activeWorkspaceId: testWorkspaceId("w1"),
		obscuredChatSessions: {},
		historyOpenRequest: null,
		layoutDocumentsByWorkspace: {
			w1: {
				center: {
					kind: "split" as const,
					id: "split",
					orientation: "horizontal" as const,
					ratio: 0.5,
					children: [
						{ kind: "group" as const, id: "left", tabs: [chat("t-a", testSessionId("a"))] },
						{
							kind: "group" as const,
							id: "right",
							tabs: [chat("t-b", testSessionId("b")), chat("t-c", testSessionId("c"))],
						},
					],
				},
			},
		},
		layoutAttentionByWorkspace: {
			w1: {
				selectedByGroup: { left: "t-a", right: "t-b" },
				lastFocusedCenterGroupId: "right",
				lastFocusedSideGroupId: {},
				navigationClockByGroup: {},
			},
		},
	} as unknown as Parameters<typeof selectChatAttended>[0];
	expect(selectChatAttended(state, testWorkspaceId("w1"), testSessionId("b"))).toBe(true);
	expect(selectChatAttended(state, testWorkspaceId("w1"), testSessionId("a"))).toBe(false);
	expect(selectChatAttended(state, testWorkspaceId("w1"), testSessionId("c"))).toBe(false);
	expect(
		selectChatAttended(
			{ ...state, activeWorkspaceId: testWorkspaceId("w2") },
			testWorkspaceId("w1"),
			testSessionId("b"),
		),
	).toBe(false);
	expect(
		selectChatAttended(
			{ ...state, obscuredChatSessions: { b: true } },
			testWorkspaceId("w1"),
			testSessionId("b"),
		),
	).toBe(false);
	expect(
		selectChatAttended(
			{ ...state, historyOpenRequest: { sessionId: testSessionId("b") } },
			testWorkspaceId("w1"),
			testSessionId("b"),
		),
	).toBe(false);
	expect(
		selectChatAttended(
			{ ...state, historyOpenRequest: { sessionId: testSessionId("a") } },
			testWorkspaceId("w1"),
			testSessionId("b"),
		),
	).toBe(true);
});

test("workspace kind predicates distinguish managed and user-owned checkouts", () => {
	const managed = {};
	const external = { kind: "external" as const };
	const defaultWorkspace = { kind: "default" as const };

	expect(isDefaultWorkspace(defaultWorkspace)).toBe(true);
	expect(isExternalWorkspace(external)).toBe(true);
	expect(isUserOwnedWorkspace(managed)).toBe(false);
	expect(isUserOwnedWorkspace(defaultWorkspace)).toBe(true);
	expect(isUserOwnedWorkspace(external)).toBe(true);
});

test("layout placement lookup traverses recursive center and every auxiliary region", () => {
	const layout: WorkspaceLayoutDocument = {
		version: 2,
		center: {
			kind: "split",
			id: "split",
			direction: "horizontal",
			weights: [0.5, 0.5],
			children: [
				{ kind: "group", id: "a", tabs: [] },
				{
					kind: "group",
					id: "b",
					tabs: [{ kind: "file", id: "legacy-file-placement", name: "a", path: "a" }],
				},
			],
		},
		left: { visible: false, width: 0.2, groups: [] },
		right: {
			visible: true,
			width: 0.2,
			groups: [
				{
					id: "right",
					weight: 1,
					folded: false,
					tabs: [{ kind: "tool", id: "tool:files", name: "Files", tool: "files" }],
				},
			],
		},
		bottom: {
			visible: true,
			height: 0.3,
			alignment: "center",
			groups: [
				{
					id: "bottom",
					weight: 1,
					folded: false,
					tabs: [
						{
							kind: "terminal",
							id: "bottom-terminal",
							name: "Terminal 1",
							tabKey: "terminal-1",
						},
					],
				},
			],
		},
		toolRestoreTargets: {},
	};
	const state = {
		layoutDocumentsByWorkspace: { ws: layout },
		layoutAttentionByWorkspace: {
			ws: {
				selectedByGroup: { b: "legacy-file-placement" },
				lastFocusedCenterGroupId: "b",
				lastFocusedSideGroupId: {},
				navigationClockByGroup: { a: 0, b: 0 },
			},
		},
		tabsByWorkspace: {
			ws: [
				{
					kind: "file" as const,
					id: "file:a",
					workspaceId: testWorkspaceId("ws"),
					name: "a",
					path: "a",
					content: "",
				},
			],
		},
		terminalsByWorkspace: {},
	};
	expect(selectLayoutTabPlaced(state, testWorkspaceId("ws"), "legacy-file-placement")).toBe(true);
	expect(selectLayoutTabPlacement(state, testWorkspaceId("ws"), "legacy-file-placement")).toEqual({
		area: "center",
		groupId: "b",
	});
	expect(selectLayoutTabPlaced(state, testWorkspaceId("ws"), "tool:files")).toBe(true);
	expect(selectLayoutTabPlacement(state, testWorkspaceId("ws"), "bottom-terminal")).toEqual({
		area: "bottom",
		groupId: "bottom",
	});
	expect(
		selectLayoutResourcePlacement(state, testWorkspaceId("ws"), {
			kind: "terminal",
			id: "another-placement-id",
			name: "Terminal",
			tabKey: "terminal-1",
		}),
	).toMatchObject({ area: "bottom", groupId: "bottom", tabId: "bottom-terminal" });
	expect(selectLayoutTabPlaced(state, testWorkspaceId("ws"), "missing")).toBe(false);
	expect(selectAttentionCenterTab(state, testWorkspaceId("ws"))?.id).toBe("legacy-file-placement");
	const cachedResource = state.tabsByWorkspace.ws[0];
	if (!cachedResource) throw new Error("missing editor cache fixture");
	expect(selectLayoutResourcePlacement(state, testWorkspaceId("ws"), cachedResource)).toEqual({
		area: "center",
		groupId: "b",
		tabId: "legacy-file-placement",
		tab: { kind: "file", id: "legacy-file-placement", name: "a", path: "a" },
	});
	expect(selectAttentionCenterResourceReady(state, testWorkspaceId("ws"))).toBe(true);
	expect(selectAttentionCenterResourceCacheKey(state, testWorkspaceId("ws"))).toBe("file:a");
	state.tabsByWorkspace.ws[0] = { ...cachedResource, id: "legacy-file-placement" };
	expect(selectAttentionCenterResourceCacheKey(state, testWorkspaceId("ws"))).toBe(
		"legacy-file-placement",
	);
});

test("registered documents participate in legacy selection readiness", () => {
	const layout: WorkspaceLayoutDocument = {
		version: 2,
		center: {
			kind: "group",
			id: "center",
			tabs: [
				{
					kind: "document",
					id: "shared-todo",
					name: "TODO",
					documentKind: "todo-plan",
					sourceId: "session",
					docPath: "TODO.md",
				},
			],
		},
		left: { visible: false, width: 0.2, groups: [] },
		right: { visible: false, width: 0.2, groups: [] },
		bottom: { visible: false, height: 0.3, alignment: "center", groups: [] },
		toolRestoreTargets: {},
	};
	const state = {
		layoutDocumentsByWorkspace: { ws: layout },
		layoutAttentionByWorkspace: {
			ws: {
				selectedByGroup: { center: "shared-todo" },
				lastFocusedCenterGroupId: "center",
				lastFocusedSideGroupId: {},
				navigationClockByGroup: { center: 0 },
			},
		},
		tabsByWorkspace: {
			ws: [
				{
					kind: "doc" as const,
					id: "local-todo",
					workspaceId: testWorkspaceId("ws"),
					name: "TODO",
					content: "",
					docPath: "TODO.md",
					sourceId: "session",
				},
			],
		},
		terminalsByWorkspace: {},
	};
	expect(selectAttentionCenterResourceReady(state, testWorkspaceId("ws"))).toBe(true);
	expect(selectAttentionCenterResourceCacheKey(state, testWorkspaceId("ws"))).toBe("local-todo");
});

test("active workspace selectors resolve the workspace and its owning project", () => {
	const state = { activeWorkspaceId: testWorkspaceId("w2"), workspaces };

	expect(selectActiveWorkspace(state)).toBe(workspace);
	expect(selectActiveWorkspaceProjectId(state)).toBe(testProjectId("p2"));
});

test("active workspace selectors return null when the workspace is absent", () => {
	const state = { activeWorkspaceId: testWorkspaceId("missing"), workspaces };

	expect(selectActiveWorkspace(state)).toBeNull();
	expect(selectActiveWorkspaceProjectId(state)).toBeNull();
});

test("context project prefers the active workspace owner", () => {
	expect(
		selectContextProject({
			activeWorkspaceId: testWorkspaceId("w2"),
			selectedProjectId: testProjectId("p1"),
			projects,
			workspaces,
		}),
	).toBe(projectTwo);
});

test("context project falls back to the selected Project Home", () => {
	expect(
		selectContextProject({
			activeWorkspaceId: null,
			selectedProjectId: testProjectId("p1"),
			projects,
			workspaces,
		}),
	).toBe(projectOne);
});

test("selectSkillsStale is a strict tick comparison, defaulting missing ticks to 0", () => {
	const stale = { skillChangeTickByWorkspace: { w: 2 }, skillsSyncedTickBySession: { s: 1 } };
	expect(selectSkillsStale(stale, testWorkspaceId("w"), testSessionId("s"))).toBe(true);
	const synced = { skillChangeTickByWorkspace: { w: 2 }, skillsSyncedTickBySession: { s: 2 } };
	expect(selectSkillsStale(synced, testWorkspaceId("w"), testSessionId("s"))).toBe(false);
	expect(
		selectSkillsStale(
			{ skillChangeTickByWorkspace: { w: 1 }, skillsSyncedTickBySession: {} },
			testWorkspaceId("w"),
			testSessionId("s"),
		),
	).toBe(true);
	expect(
		selectSkillsStale(
			{ skillChangeTickByWorkspace: {}, skillsSyncedTickBySession: {} },
			testWorkspaceId("w"),
			testSessionId("s"),
		),
	).toBe(false);
});

const chat1: EditorTab = {
	kind: "chat",
	id: "w2:s1",
	workspaceId: testWorkspaceId("w2"),
	name: "One",
	sessionId: testSessionId("s1"),
};
const chat2: EditorTab = {
	kind: "chat",
	id: "w2:s2",
	workspaceId: testWorkspaceId("w2"),
	name: "Two",
	sessionId: testSessionId("s2"),
};
const fileTab: EditorTab = {
	kind: "file",
	id: "w2:src/a.ts",
	workspaceId: testWorkspaceId("w2"),
	name: "a.ts",
	path: "src/a.ts",
	content: "",
};

test("selectKnownChatLocation resolves open and history chats without guessing unknown sessions", () => {
	const state = {
		tabsByWorkspace: { w2: [fileTab, chat1] },
		closedChatsByWorkspace: {
			w3: [{ sessionId: testSessionId("closed-session"), title: "Closed chat", closedAt: 1 }],
		},
	};
	expect(selectKnownChatLocation(state, testSessionId("s1"))).toEqual({
		workspaceId: testWorkspaceId("w2"),
		title: "One",
	});
	expect(selectKnownChatLocation(state, testSessionId("closed-session"))).toEqual({
		workspaceId: testWorkspaceId("w3"),
		title: "Closed chat",
	});
	expect(selectKnownChatLocation(state, testSessionId("other-client-session"))).toBeNull();
});

test("selectActiveEditorTab resolves the mirrored render-cache selection", () => {
	const legacyPlacement: EditorTab = { ...fileTab, id: "legacy-stable-placement" };
	const tabs = [fileTab, legacyPlacement];
	expect(
		selectActiveEditorTab(
			{ tabsByWorkspace: { w2: tabs }, activeTabByWorkspace: { w2: "legacy-stable-placement" } },
			testWorkspaceId("w2"),
		),
	).toBe(legacyPlacement);
});

test("selectHistoryTarget prefers the active chat tab", () => {
	expect(
		selectHistoryTarget({
			activeWorkspaceId: testWorkspaceId("w2"),
			tabsByWorkspace: { w2: [chat1, chat2, fileTab] },
			activeTabByWorkspace: { w2: "w2:s1" },
		}),
	).toEqual({ workspaceId: testWorkspaceId("w2"), tabId: "w2:s1", sessionId: testSessionId("s1") });
});

test("selectHistoryTarget falls back to the newest chat tab when a non-chat tab is active", () => {
	for (const activeTabId of ["w2:src/a.ts", null]) {
		expect(
			selectHistoryTarget({
				activeWorkspaceId: testWorkspaceId("w2"),
				tabsByWorkspace: { w2: [chat1, chat2, fileTab] },
				activeTabByWorkspace: { w2: activeTabId },
			}),
		).toEqual({
			workspaceId: testWorkspaceId("w2"),
			tabId: "w2:s2",
			sessionId: testSessionId("s2"),
		});
	}
});

test("selectHistoryTarget is null only with no chat to open", () => {
	expect(
		selectHistoryTarget({
			activeWorkspaceId: testWorkspaceId("w2"),
			tabsByWorkspace: { w2: [fileTab] },
			activeTabByWorkspace: { w2: "w2:src/a.ts" },
		}),
	).toBeNull();
	expect(
		selectHistoryTarget({
			activeWorkspaceId: null,
			tabsByWorkspace: { w2: [chat1] },
			activeTabByWorkspace: { w2: "w2:s1" },
		}),
	).toBeNull();
	expect(
		selectHistoryTarget({
			activeWorkspaceId: testWorkspaceId("w1"),
			tabsByWorkspace: { w2: [chat1] },
			activeTabByWorkspace: { w1: "w2:s1" },
		}),
	).toBeNull();
});

test("matchesWorktreePath accepts the relative form and an absolute report, anchored at a separator", () => {
	expect(matchesWorktreePath("src/foo.ts", "src/foo.ts")).toBe(true);
	expect(matchesWorktreePath("/wt/src/foo.ts", "src/foo.ts")).toBe(true);
	expect(matchesWorktreePath("C:\\wt\\src/foo.ts", "src/foo.ts")).toBe(true);
	expect(matchesWorktreePath("/wt/src/a-foo.ts", "src/foo.ts")).toBe(false);
	expect(matchesWorktreePath("src/other.ts", "src/foo.ts")).toBe(false);
	expect(matchesWorktreePath("./src/foo.ts", "src/foo.ts")).toBe(true);
});

test("matchesWorktreePath does not let a RELATIVE report match a shorter entry by suffix", () => {
	expect(matchesWorktreePath("module-b/SPEC.md", "SPEC.md")).toBe(false);
	expect(matchesWorktreePath("packages/server/SPEC.md", "SPEC.md")).toBe(false);
	expect(matchesWorktreePath("/wt/ws/SPEC.md", "SPEC.md")).toBe(true);
});

test("specPathMatcher recognizes a spec by graph membership, in either reported form", () => {
	const nodes = [
		{
			id: "task-x",
			type: "task-spec",
			title: "X",
			path: ".thinkrail/context/TASK-x.md",
			dependsOn: [],
			references: [],
			implements: [],
			tags: [],
		},
	];
	const isSpec = specPathMatcher(nodes);

	expect(isSpec(".thinkrail/context/TASK-x.md")).toBe(true);
	expect(isSpec("/wt/ws/.thinkrail/context/TASK-x.md")).toBe(true);
	expect(isSpec("packages/server/src/todos/todos.ts")).toBe(false);
	expect(specPathMatcher([])(".thinkrail/context/TASK-x.md")).toBe(false);
});

const catalogModel = (
	provider: string,
	id: string,
	thinkingLevels: WireModel["thinkingLevels"],
) => ({
	id,
	name: id,
	provider,
	contextWindow: 200_000,
	reasoning: thinkingLevels.length > 1,
	thinkingLevels,
});

test("selectCatalogModel matches on {provider,id} — an id alone is ambiguous across providers", () => {
	const bedrock = catalogModel("bedrock", "opus-5", ["off", "medium"]);
	const anthropic = catalogModel("anthropic", "opus-5", ["off", "high"]);
	expect(selectCatalogModel([bedrock, anthropic], { provider: "anthropic", id: "opus-5" })).toBe(
		anthropic,
	);
	expect(selectCatalogModel([bedrock, anthropic], null)).toBeNull();
});

test("selectCatalogModel returns the LIVE entry, not the stale ref handed to it", () => {
	const stale = catalogModel("anthropic", "opus-5", ["off", "low"]);
	const live = catalogModel("anthropic", "opus-5", ["off", "low", "medium", "high"]);
	expect(selectCatalogModel([live], stale)?.thinkingLevels).toEqual(live.thinkingLevels);
});

test("selectCatalogModel is null when the ref left the catalog (caller keeps its snapshot)", () => {
	const gone = catalogModel("anthropic", "opus-4", ["off"]);
	expect(selectCatalogModel([catalogModel("anthropic", "opus-5", ["off"])], gone)).toBeNull();
});

test("selectAgentReviewCommentCount counts only OPEN agent-authored comments", () => {
	const state = {
		reviewsByWorkspace: {
			w1: {
				comments: [
					{ status: "draft", author: "agent" }, // open agent finding
					{ status: "sent", author: "agent" }, // open (sent to worker) agent finding
					{ status: "resolved", author: "agent" }, // closed → excluded
					{ status: "dismissed", author: "agent" }, // closed → excluded
					{ status: "draft", author: "user" }, // human comment → excluded
					{ status: "draft" }, // author absent (human default) → excluded
				],
			},
		},
	};
	expect(selectAgentReviewCommentCount(state, testWorkspaceId("w1"))).toBe(2);
	expect(selectAgentReviewCommentCount(state, testWorkspaceId("missing"))).toBe(0);
	expect(selectAgentReviewCommentCount(state, null)).toBe(0);
});

describe("selectSupportsModelPicker", () => {
	test("requires a connected host at or above the picker protocol", () => {
		expect(selectSupportsModelPicker({ protocolVersion: null })).toBe(false);
		expect(selectSupportsModelPicker({ protocolVersion: MODEL_PICKER_PROTOCOL_VERSION - 1 })).toBe(
			false,
		);
		expect(selectSupportsModelPicker({ protocolVersion: MODEL_PICKER_PROTOCOL_VERSION })).toBe(
			true,
		);
	});
});

describe("file change signal", () => {
	const batch = (paths: string[], truncated = false) => ({ tick: 1, paths, truncated });

	test("a truncated or pathless batch means anything may have changed", () => {
		expect(fsChangedPaths(batch(["a.html"]))).toEqual(["a.html"]);
		expect(fsChangedPaths(batch(["a.html"], true))).toBeNull();
		expect(fsChangedPaths(batch([]))).toBeNull();
	});

	test("a new connection reports anything; an untouched workspace reports nothing", () => {
		const previous = { connectionGeneration: 1, fsChangesByWorkspace: { ws: batch(["a.html"]) } };
		expect(selectFileChangeSince(previous, previous, testWorkspaceId("ws"))).toBeUndefined();
		expect(
			selectFileChangeSince(
				{ ...previous, connectionGeneration: 2 },
				previous,
				testWorkspaceId("ws"),
			),
		).toBeNull();
		const next = { ...previous, fsChangesByWorkspace: { ws: batch(["b.html"]) } };
		expect(selectFileChangeSince(next, previous, testWorkspaceId("ws"))).toEqual(["b.html"]);
		expect(selectFileChangeSince(next, previous, testWorkspaceId("other"))).toBeUndefined();
	});
});

test("the host-named default workspace shows in the interface language until it is renamed", () => {
	applyLocale("de", { de: { "store.workspace.defaultName": "Standard" } });
	try {
		const t = currentTranslator();
		expect(workspaceName(t, { kind: "default", name: "Default" })).toBe("Standard");
		expect(workspaceName(t, { kind: "default", name: "Main checkout" })).toBe("Main checkout");
		expect(workspaceName(t, { name: "Default" })).toBe("Default");
	} finally {
		applyLocale("en", {});
	}
});

describe("the known title of a chat", () => {
	const quiet: SessionState = {
		execution: "idle",
		runId: null,
		needsInput: null,
		completion: null,
		completionUnread: false,
		queuedCount: 0,
		backgroundWork: false,
	};
	const record = (sessionId: SessionId, title?: string): SessionStateRecord => ({
		sessionId,
		projectId: testProjectId("p1"),
		workspaceId: testWorkspaceId("w1"),
		state: quiet,
		...(title === undefined ? {} : { title }),
	});
	const layout = (sessionId: SessionId, name: string): WorkspaceLayoutDocument =>
		({
			center: { kind: "group", id: "g1", tabs: [{ kind: "chat", id: "t1", sessionId, name }] },
		}) as never;
	const state = (
		records: SessionStateRecord[],
		options: { tab?: [SessionId, string]; closed?: [SessionId, string] } = {},
	) => ({
		sessionStateByWorkspace: {
			w1: Object.fromEntries(records.map((entry) => [entry.sessionId, entry])),
		},
		layoutDocumentsByWorkspace: options.tab ? { w1: layout(...options.tab) } : {},
		closedChatsByWorkspace: options.closed
			? { w1: [{ sessionId: options.closed[0], title: options.closed[1], closedAt: 0 }] }
			: {},
	});

	test("the host's record wins over a stale tab or history copy", () => {
		expect(
			selectKnownChatTitle(
				state([record(testSessionId("s1"), "After")], {
					tab: [testSessionId("s1"), "Before"],
					closed: [testSessionId("s1"), "Before"],
				}),
				testWorkspaceId("w1"),
				testSessionId("s1"),
			),
		).toBe("After");
	});

	test("an empty title on the record means unnamed, so no stale copy comes back", () => {
		expect(
			selectKnownChatTitle(
				state([record(testSessionId("s1"), "")], {
					tab: [testSessionId("s1"), "Old"],
					closed: [testSessionId("s1"), "Old"],
				}),
				testWorkspaceId("w1"),
				testSessionId("s1"),
			),
		).toBeNull();
	});

	test("a record from a host that sends no title falls back to the tab, then the history row", () => {
		expect(
			selectKnownChatTitle(
				state([record(testSessionId("s1"))], { tab: [testSessionId("s1"), "From the tab"] }),
				testWorkspaceId("w1"),
				testSessionId("s1"),
			),
		).toBe("From the tab");
		expect(
			selectKnownChatTitle(
				state([record(testSessionId("s1"))], {
					tab: [testSessionId("s1"), ""],
					closed: [testSessionId("s1"), "Durable name"],
				}),
				testWorkspaceId("w1"),
				testSessionId("s1"),
			),
		).toBe("Durable name");
		expect(
			selectKnownChatTitle(
				state([record(testSessionId("s1"))]),
				testWorkspaceId("w1"),
				testSessionId("s1"),
			),
		).toBeNull();
	});
});

describe("the first prompt of an unnamed chat", () => {
	const quiet: SessionState = {
		execution: "idle",
		runId: null,
		needsInput: null,
		completion: null,
		completionUnread: false,
		queuedCount: 0,
		backgroundWork: false,
	};
	const record = (sessionId: SessionId, firstPrompt?: string): SessionStateRecord => ({
		sessionId,
		projectId: testProjectId("p1"),
		workspaceId: testWorkspaceId("w1"),
		state: quiet,
		...(firstPrompt ? { firstPrompt } : {}),
	});
	const userTurn = (text: string) => ({
		kind: "user" as const,
		id: `turn-${text}`,
		message: { role: "user" as const, content: text, timestamp: 1 },
	});
	const chatTab = (sessionId: SessionId, name: string): EditorTab => ({
		kind: "chat",
		id: `chat:w1:${sessionId}`,
		workspaceId: testWorkspaceId("w1"),
		name,
		sessionId,
	});

	test("prefers the host's record, then the closed-chat summary, then the loaded runtime's turns", () => {
		const state = {
			sessions: {
				s1: { ...EMPTY_RUNTIME, turns: [userTurn("From the runtime")] },
				s2: { ...EMPTY_RUNTIME, turns: [userTurn("Only the runtime knows")] },
				s4: {
					...EMPTY_RUNTIME,
					turns: [userTurn('<review id="r" branch="b" base="c" comments="0">')],
				},
				s5: {
					...EMPTY_RUNTIME,
					turns: [
						userTurn('<review id="r" branch="b" base="c" comments="0">'),
						userTurn("/skill:brainstorming A later real prompt"),
					],
				},
			},
			sessionStateByWorkspace: {
				w1: {
					s1: record(testSessionId("s1"), "From the record"),
					s2: record(testSessionId("s2")),
					s6: record(testSessionId("s6"), "Pushed after a peer created it"),
				},
			},
			closedChatsByWorkspace: {
				w1: [
					{
						sessionId: testSessionId("s3"),
						title: "",
						firstPrompt: "From the closed summary",
						closedAt: 1,
					},
					{ sessionId: testSessionId("s6"), title: "", closedAt: 2 },
				],
			},
		};
		expect(selectChatFirstPrompt(state, testWorkspaceId("w1"), testSessionId("s1"))).toBe(
			"From the record",
		);
		expect(selectChatFirstPrompt(state, testWorkspaceId("w1"), testSessionId("s2"))).toBe(
			"Only the runtime knows",
		);
		expect(selectChatFirstPrompt(state, testWorkspaceId("w1"), testSessionId("s3"))).toBe(
			"From the closed summary",
		);
		expect(
			selectChatFirstPrompt(state, testWorkspaceId("w1"), testSessionId("s4")),
		).toBeUndefined();
		expect(selectChatFirstPrompt(state, testWorkspaceId("w1"), testSessionId("s5"))).toBe(
			"A later real prompt",
		);
		expect(selectChatFirstPrompt(state, testWorkspaceId("w1"), testSessionId("s6"))).toBe(
			"Pushed after a peer created it",
		);
		expect(
			selectChatFirstPrompt(state, testWorkspaceId("w1"), testSessionId("unknown")),
		).toBeUndefined();
	});

	test("titles and tab labels fall back to the prompt only while the chat has no name", () => {
		const t = currentTranslator();
		const planTab: EditorTab = {
			kind: "plan",
			id: "plan:w1:s4",
			workspaceId: testWorkspaceId("w1"),
			name: "",
			sessionId: testSessionId("s4"),
		};
		const state = {
			tabsByWorkspace: {
				w1: [
					chatTab(testSessionId("s1"), ""),
					chatTab(testSessionId("s2"), "Named by the agent"),
					chatTab(testSessionId("s3"), ""),
					planTab,
				],
			},
			sessions: {},
			sessionStateByWorkspace: {
				w1: {
					s1: record(testSessionId("s1"), "Fix the login redirect"),
					s2: record(testSessionId("s2"), "Please rename me"),
					s4: record(testSessionId("s4"), "Plan this one"),
				},
			},
			closedChatsByWorkspace: {},
		};
		expect(selectChatTitle(t, state, testWorkspaceId("w1"), testSessionId("s1"))).toBe(
			"Fix the login redirect",
		);
		expect(selectChatTitle(t, state, testWorkspaceId("w1"), testSessionId("s2"))).toBe(
			"Named by the agent",
		);
		expect(selectChatTitle(t, state, testWorkspaceId("w1"), testSessionId("s3"))).toBe("Chat");
		expect(selectUnnamedChatFirstPrompts(state, testWorkspaceId("w1"))).toEqual({
			s1: "Fix the login redirect",
			s4: "Plan this one",
		});
	});
});
