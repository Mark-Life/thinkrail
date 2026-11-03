import { afterEach, beforeEach, expect, test } from "bun:test";
import type {
	PiEvent,
	Project,
	ProjectId,
	SessionId,
	Workspace,
	WorkspaceId,
} from "@thinkrail/contracts";
import { testProjectId, testSessionId, testWorkspaceId } from "@thinkrail/contracts/test-ids";
import { layoutOpenOptionsForNavigation, selectAttentionCenterTab, useAppStore } from "../store";
import type { NavigationDriver } from "./driver";
import { startNavigation } from "./restore";

type WorkspaceLayoutDocument = Parameters<
	typeof selectAttentionCenterTab
>[0]["layoutDocumentsByWorkspace"][string];

function project(id: string): Project {
	return { id: testProjectId(id), name: id, path: `/tmp/${id}`, slug: id, lastOpened: 1 };
}

function workspace(id: string, projectId = "00000000-0000-4000-8000-0000000000a1"): Workspace {
	return {
		id: testWorkspaceId(id),
		projectId: testProjectId(projectId),
		name: id,
		branch: id,
		worktreePath: `/tmp/${projectId}/${id}`,
		baseBranch: "main",
	};
}

function fakeDriver(initial = "") {
	let fragment = initial;
	const handlers = new Set<(fragment: string) => void>();
	const writes: { kind: "replace" | "push"; fragment: string }[] = [];
	const driver: NavigationDriver = {
		read: () => fragment,
		replace: (next) => {
			fragment = next;
			writes.push({ kind: "replace", fragment: next });
		},
		push: (next) => {
			fragment = next;
			writes.push({ kind: "push", fragment: next });
		},
		onIncoming: (handler) => {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
	};
	return {
		driver,
		writes,
		get replaces() {
			return writes.filter((w) => w.kind === "replace").map((w) => w.fragment);
		},
		get pushes() {
			return writes.filter((w) => w.kind === "push").map((w) => w.fragment);
		},
		get fragment() {
			return fragment;
		},
		incoming(next: string) {
			fragment = next;
			for (const handler of handlers) handler(next);
		},
	};
}

function fakeLists() {
	const calls: {
		projectId: ProjectId;
		resolve: (rows: Workspace[]) => void;
		reject: (err: Error) => void;
	}[] = [];
	const listWorkspaces = (projectId: ProjectId) =>
		new Promise<Workspace[]>((resolve, reject) => {
			calls.push({ projectId, resolve, reject });
		});
	return { calls, listWorkspaces };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function installWelcome(projects: Project[]): void {
	useAppStore.getState().installWelcomeSnapshot(1, projects, projects);
}

function placeChats(
	workspaceId: WorkspaceId,
	sessionIds: SessionId[],
	selected: string,
	clock?: number,
): void {
	const document: WorkspaceLayoutDocument = {
		version: 2,
		center: {
			kind: "group",
			id: "center",
			tabs: sessionIds.map((sessionId) => ({
				kind: "chat",
				id: `placed:${sessionId}`,
				name: "Chat",
				sessionId,
			})),
		},
		left: { visible: false, width: 0.2, groups: [] },
		right: { visible: false, width: 0.2, groups: [] },
		bottom: { visible: false, height: 0.3, alignment: "center", groups: [] },
		toolRestoreTargets: {},
	};
	useAppStore.setState((state) => ({
		layoutDocumentsByWorkspace: {
			...state.layoutDocumentsByWorkspace,
			[workspaceId]: document,
		},
		layoutAttentionByWorkspace: {
			...state.layoutAttentionByWorkspace,
			[workspaceId]: {
				selectedByGroup: { center: `placed:${selected}` },
				lastFocusedCenterGroupId: "center",
				lastFocusedSideGroupId: {},
				navigationClockByGroup: {
					center:
						clock ??
						state.layoutAttentionByWorkspace[workspaceId]?.navigationClockByGroup.center ??
						0,
				},
			},
		},
	}));
}

function selectChatPlacement(workspaceId: WorkspaceId, sessionId: SessionId): void {
	placeChats(workspaceId, [sessionId], sessionId);
}

let stop: (() => void) | null = null;

beforeEach(() => {
	useAppStore.setState({
		status: "connecting",
		connectionGeneration: 0,
		welcomeGeneration: 0,
		protocolVersion: null,
		projects: [],
		recentProjects: [],
		workspaces: {},
		selectedProjectId: null,
		activeWorkspaceId: null,
		routeChatTarget: null,
		routeChatTargetGeneration: 0,
		workbenchFrame: null,
		workspaceViewsByWorkspace: {},
		layoutStateReady: false,
		layoutDocumentsByWorkspace: {},
		layoutAttentionByWorkspace: {},
		layoutProjectionEpoch: 0,
		tabsByWorkspace: {},
		activeTabByWorkspace: {},
		previewTabByWorkspace: {},
		navTickByWorkspace: {},
		closedChatsByWorkspace: {},
		deletedSessionsByWorkspace: {},
		sessions: {},
		skillsSyncedTickBySession: {},
		fsChangesByWorkspace: {},
		toasts: [],
	});
});

afterEach(() => {
	stop?.();
	stop = null;
});

test("no restore runs before the atomic welcome generation", async () => {
	const d = fakeDriver(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s1",
	);
	const { calls, listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	await settle();
	useAppStore.getState().setStatus("connected");
	await settle();
	expect(calls).toHaveLength(0);
	expect(useAppStore.getState().activeWorkspaceId).toBeNull();
	expect(d.fragment).toBe(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s1",
	);

	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	await settle();
	expect(calls).toHaveLength(1);
	expect(calls[0]?.projectId).toBe(testProjectId("00000000-0000-4000-8000-0000000000a1"));
	calls[0]?.resolve([workspace("00000000-0000-4000-8000-0000000000b1")]);
	await settle();
	const state = useAppStore.getState();
	expect(state.activeWorkspaceId).toBe(testWorkspaceId("00000000-0000-4000-8000-0000000000b1"));
	expect(state.selectedProjectId).toBe(testProjectId("00000000-0000-4000-8000-0000000000a1"));
	expect(state.routeChatTarget).toEqual({
		workspaceId: testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		sessionId: testSessionId("s1"),
		navTick: 1,
		navigation: null,
		validated: false,
	});
	expect(d.fragment).toBe(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s1",
	);
});

test("duplicate welcome delivery starts at most one active restore read", async () => {
	const d = fakeDriver(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1",
	);
	const { calls, listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	await settle();
	expect(calls).toHaveLength(1);
	calls[0]?.resolve([workspace("00000000-0000-4000-8000-0000000000b1")]);
	await settle();
	expect(useAppStore.getState().activeWorkspaceId).toBe(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
	);
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	await settle();
	expect(calls).toHaveLength(1);
});

test("a malformed initial fragment canonicalizes to #/v1 and restores nothing", async () => {
	const d = fakeDriver("#/v2/projects/00000000-0000-4000-8000-0000000000a1/bogus");
	const { calls, listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	await settle();
	expect(d.fragment).toBe("#/v1");
	expect(calls).toHaveLength(0);
	expect(useAppStore.getState().activeWorkspaceId).toBeNull();
});

test("a newer incoming fragment cancels the older restore's landing", async () => {
	const d = fakeDriver(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1",
	);
	const { calls, listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	await settle();
	d.incoming(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b2",
	);
	await settle();
	expect(calls).toHaveLength(2);
	calls[0]?.resolve([
		workspace("00000000-0000-4000-8000-0000000000b1"),
		workspace("00000000-0000-4000-8000-0000000000b2"),
	]);
	await settle();
	expect(useAppStore.getState().activeWorkspaceId).toBeNull();
	calls[1]?.resolve([
		workspace("00000000-0000-4000-8000-0000000000b1"),
		workspace("00000000-0000-4000-8000-0000000000b2"),
	]);
	await settle();
	expect(useAppStore.getState().activeWorkspaceId).toBe(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b2"),
	);
});

test("fresh user navigation wins over a delayed workspace response", async () => {
	const d = fakeDriver(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s1",
	);
	const { calls, listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	await settle();
	useAppStore
		.getState()
		.setWorkspaces(testProjectId("00000000-0000-4000-8000-0000000000a1"), [
			workspace("00000000-0000-4000-8000-0000000000b1"),
			workspace("00000000-0000-4000-8000-0000000000b2"),
		]);
	useAppStore.getState().activateWorkspace(workspace("00000000-0000-4000-8000-0000000000b2"));
	expect(d.fragment).toBe(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b2",
	);
	await settle();
	calls[0]?.resolve([
		workspace("00000000-0000-4000-8000-0000000000b1"),
		workspace("00000000-0000-4000-8000-0000000000b2"),
	]);
	await settle();
	const state = useAppStore.getState();
	expect(state.activeWorkspaceId).toBe(testWorkspaceId("00000000-0000-4000-8000-0000000000b2"));
	expect(state.routeChatTarget).toBeNull();
	expect(d.fragment).toBe(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b2",
	);
});

test("same-workspace center navigation wins over a delayed route response", async () => {
	const d = fakeDriver("");
	const { calls, listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	const store = useAppStore.getState();
	store.setWorkspaces(testProjectId("00000000-0000-4000-8000-0000000000a1"), [
		workspace("00000000-0000-4000-8000-0000000000b1"),
	]);
	store.activateWorkspace(workspace("00000000-0000-4000-8000-0000000000b1"));
	store.openChatSession(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		testSessionId("s1"),
		null,
		"medium",
	);

	d.incoming(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s1",
	);
	await settle();
	expect(calls).toHaveLength(1);
	store.noteNavigation(testWorkspaceId("00000000-0000-4000-8000-0000000000b1"));
	store.openTab(
		{
			kind: "file",
			id: "00000000-0000-4000-8000-0000000000b1:README.md",
			workspaceId: testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
			name: "README.md",
			path: "README.md",
			content: "",
		},
		"keep",
	);
	expect(d.fragment).toBe(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1",
	);

	calls[0]?.resolve([workspace("00000000-0000-4000-8000-0000000000b1")]);
	await settle();
	expect(useAppStore.getState().routeChatTarget).toBeNull();
	expect(useAppStore.getState().activeTabByWorkspace["00000000-0000-4000-8000-0000000000b1"]).toBe(
		"00000000-0000-4000-8000-0000000000b1:README.md",
	);
	expect(d.fragment).toBe(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1",
	);
});

test("user navigation past an installed exact-chat target cancels it and resumes URL sync", async () => {
	const d = fakeDriver(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s1",
	);
	const { calls, listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	await settle();
	calls[0]?.resolve([workspace("00000000-0000-4000-8000-0000000000b1")]);
	await settle();
	expect(useAppStore.getState().routeChatTarget?.sessionId).toBe(testSessionId("s1"));
	useAppStore.getState().noteNavigation(testWorkspaceId("00000000-0000-4000-8000-0000000000b1"));
	expect(useAppStore.getState().routeChatTarget).toBeNull();
	expect(d.fragment).toBe(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1",
	);
	expect(d.pushes).toEqual([
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1",
	]);
});

test("a completed welcome lacking the project canonicalizes to Welcome", async () => {
	const d = fakeDriver(
		"#/v1/projects/00000000-0000-4000-8000-0000000000af/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s1",
	);
	const { calls, listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	await settle();
	expect(calls).toHaveLength(0);
	expect(useAppStore.getState().activeWorkspaceId).toBeNull();
	expect(d.fragment).toBe("#/v1");
});

test("a successful list lacking the workspace falls back to its Project Home", async () => {
	const d = fakeDriver(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000bf",
	);
	const { calls, listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	await settle();
	calls[0]?.resolve([workspace("00000000-0000-4000-8000-0000000000b1")]);
	await settle();
	const state = useAppStore.getState();
	expect(state.selectedProjectId).toBe(testProjectId("00000000-0000-4000-8000-0000000000a1"));
	expect(state.activeWorkspaceId).toBeNull();
	expect(d.fragment).toBe("#/v1/projects/00000000-0000-4000-8000-0000000000a1");
});

test("a failed workspace read is not deletion: URL and intent survive, the next welcome retries", async () => {
	const d = fakeDriver(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s1",
	);
	const { calls, listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	await settle();
	calls[0]?.reject(new Error("socket died"));
	await settle();
	expect(useAppStore.getState().activeWorkspaceId).toBeNull();
	expect(d.fragment).toBe(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s1",
	);
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	await settle();
	expect(calls).toHaveLength(2);
	calls[1]?.resolve([workspace("00000000-0000-4000-8000-0000000000b1")]);
	await settle();
	expect(useAppStore.getState().activeWorkspaceId).toBe(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
	);
	expect(useAppStore.getState().routeChatTarget?.sessionId).toBe(testSessionId("s1"));
});

test("user navigation pushes one history entry per location; unchanged locations write nothing", async () => {
	const d = fakeDriver("");
	const { listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	expect(d.fragment).toBe("#/v1");
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	await settle();

	const store = useAppStore.getState();
	store.selectProject(testProjectId("00000000-0000-4000-8000-0000000000a1"));
	expect(d.pushes).toEqual(["#/v1/projects/00000000-0000-4000-8000-0000000000a1"]);
	store.setWorkspaces(testProjectId("00000000-0000-4000-8000-0000000000a1"), [
		workspace("00000000-0000-4000-8000-0000000000b1"),
	]);
	store.activateWorkspace(workspace("00000000-0000-4000-8000-0000000000b1"));
	expect(d.pushes).toEqual([
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1",
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1",
	]);
	store.openChatSession(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		testSessionId("s1"),
		null,
		"medium",
	);
	placeChats(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		[testSessionId("s1")],
		"s1",
		1,
	);
	expect(d.pushes).toEqual([
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1",
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1",
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s1",
	]);

	const writes = d.writes.length;
	useAppStore.getState().setStatus("connected");
	expect(d.writes.length).toBe(writes);
});

test("streaming pi events cause zero History writes while the location is unchanged", async () => {
	const d = fakeDriver("");
	const { listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	const store = useAppStore.getState();
	store.setWorkspaces(testProjectId("00000000-0000-4000-8000-0000000000a1"), [
		workspace("00000000-0000-4000-8000-0000000000b1"),
	]);
	store.activateWorkspace(workspace("00000000-0000-4000-8000-0000000000b1"));
	store.openChatSession(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		testSessionId("s1"),
		null,
		"medium",
	);
	selectChatPlacement(testWorkspaceId("00000000-0000-4000-8000-0000000000b1"), testSessionId("s1"));
	await settle();

	const writes = d.writes.length;
	const delta = (text: string) =>
		({
			type: "message_update",
			assistantMessageEvent: {
				type: "text",
				partial: { role: "assistant", content: [{ type: "text", text }] },
			},
		}) as unknown as PiEvent;
	useAppStore
		.getState()
		.handlePiEvent({ type: "agent_start" } as unknown as PiEvent, testSessionId("s1"));
	for (let i = 0; i < 200; i++) {
		useAppStore.getState().handlePiEvent(delta(`chunk ${i}`), testSessionId("s1"));
	}
	expect(d.writes.length).toBe(writes);
});

test("an unresolved exact-chat target pauses URL sync until it is consumed", async () => {
	const d = fakeDriver(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s1",
	);
	const { calls, listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	await settle();
	calls[0]?.resolve([workspace("00000000-0000-4000-8000-0000000000b1")]);
	await settle();
	expect(useAppStore.getState().routeChatTarget?.sessionId).toBe(testSessionId("s1"));

	useAppStore.getState().openTab(
		{
			kind: "file",
			id: "00000000-0000-4000-8000-0000000000b1:README.md",
			workspaceId: testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
			name: "README.md",
			path: "README.md",
			content: "",
		},
		"keep",
	);
	expect(d.fragment).toBe(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s1",
	);

	useAppStore.getState().clearRouteChatTarget();
	expect(d.fragment).toBe(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1",
	);
});

test("an incoming main fragment is applied even when the client is already inside a chat", async () => {
	const d = fakeDriver("");
	const { listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	const store = useAppStore.getState();
	store.setWorkspaces(testProjectId("00000000-0000-4000-8000-0000000000a1"), [
		workspace("00000000-0000-4000-8000-0000000000b1"),
	]);
	store.activateWorkspace(workspace("00000000-0000-4000-8000-0000000000b1"));
	store.openChatSession(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		testSessionId("s1"),
		null,
		"medium",
	);
	selectChatPlacement(testWorkspaceId("00000000-0000-4000-8000-0000000000b1"), testSessionId("s1"));
	expect(d.fragment).toContain("/chats/s1");

	d.incoming("#/v1");
	await settle();
	expect(useAppStore.getState().selectedProjectId).toBeNull();
	expect(useAppStore.getState().activeWorkspaceId).toBeNull();
	expect(d.fragment).toBe("#/v1");
});

test("a missing incoming project falls back to main instead of the previous live location", async () => {
	const d = fakeDriver("");
	const { calls, listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	const store = useAppStore.getState();
	store.setWorkspaces(testProjectId("00000000-0000-4000-8000-0000000000a1"), [
		workspace("00000000-0000-4000-8000-0000000000b1"),
	]);
	store.activateWorkspace(workspace("00000000-0000-4000-8000-0000000000b1"));
	store.openChatSession(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		testSessionId("s1"),
		null,
		"medium",
	);

	d.incoming(
		"#/v1/projects/00000000-0000-4000-8000-0000000000af/workspaces/00000000-0000-4000-8000-0000000000bf/chats/s",
	);
	await settle();
	expect(calls).toHaveLength(0);
	expect(useAppStore.getState().selectedProjectId).toBeNull();
	expect(useAppStore.getState().activeWorkspaceId).toBeNull();
	expect(d.fragment).toBe("#/v1");
});

test("a workspace-level route retains existing local attention and canonicalizes to its selected chat", async () => {
	const d = fakeDriver("");
	const { calls, listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	const store = useAppStore.getState();
	store.setWorkspaces(testProjectId("00000000-0000-4000-8000-0000000000a1"), [
		workspace("00000000-0000-4000-8000-0000000000b1"),
	]);
	store.activateWorkspace(workspace("00000000-0000-4000-8000-0000000000b1"));
	store.openChatSession(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		testSessionId("s1"),
		null,
		"medium",
	);
	selectChatPlacement(testWorkspaceId("00000000-0000-4000-8000-0000000000b1"), testSessionId("s1"));

	const pushesBefore = d.pushes.length;
	d.incoming(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1",
	);
	await settle();
	expect(calls).toHaveLength(1);
	calls[0]?.resolve([workspace("00000000-0000-4000-8000-0000000000b1")]);
	await settle();
	const state = useAppStore.getState();
	expect(
		selectAttentionCenterTab(state, testWorkspaceId("00000000-0000-4000-8000-0000000000b1")),
	).toMatchObject({
		kind: "chat",
		sessionId: testSessionId("s1"),
	});
	expect(state.routeChatTarget).toBeNull();
	expect(d.fragment).toBe(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s1",
	);
	expect(d.pushes.length).toBe(pushesBefore);
});

test("an older response cannot unmark a newer generation's in-flight read", async () => {
	const d = fakeDriver(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1",
	);
	const { calls, listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	await settle();
	d.incoming(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b2",
	);
	await settle();
	expect(calls).toHaveLength(2);

	calls[0]?.resolve([
		workspace("00000000-0000-4000-8000-0000000000b1"),
		workspace("00000000-0000-4000-8000-0000000000b2"),
	]);
	await settle();
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	await settle();
	expect(calls).toHaveLength(2);
	calls[1]?.resolve([
		workspace("00000000-0000-4000-8000-0000000000b1"),
		workspace("00000000-0000-4000-8000-0000000000b2"),
	]);
	await settle();
	expect(useAppStore.getState().activeWorkspaceId).toBe(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b2"),
	);
});

test("teardown detaches the coordinator from driver and store", async () => {
	const d = fakeDriver("");
	const { listWorkspaces } = fakeLists();
	const dispose = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	await settle();
	dispose();
	const writes = d.writes.length;
	useAppStore.getState().selectProject(testProjectId("00000000-0000-4000-8000-0000000000a1"));
	expect(d.writes.length).toBe(writes);
});

test("a user chat-tab switch (attention clock advance) pushes exactly one entry", async () => {
	const d = fakeDriver("");
	const { listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	const store = useAppStore.getState();
	store.setWorkspaces(testProjectId("00000000-0000-4000-8000-0000000000a1"), [
		workspace("00000000-0000-4000-8000-0000000000b1"),
	]);
	store.activateWorkspace(workspace("00000000-0000-4000-8000-0000000000b1"));
	store.openChatSession(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		testSessionId("s1"),
		null,
		"medium",
	);
	store.openChatSession(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		testSessionId("s2"),
		null,
		"medium",
	);
	placeChats(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		[testSessionId("s1"), testSessionId("s2")],
		"s1",
		1,
	);
	await settle();
	expect(d.fragment).toBe(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s1",
	);

	const pushesBefore = d.pushes.length;
	useAppStore.getState().noteNavigation(testWorkspaceId("00000000-0000-4000-8000-0000000000b1"));
	placeChats(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		[testSessionId("s1"), testSessionId("s2")],
		"s2",
		2,
	);
	expect(d.pushes.length).toBe(pushesBefore + 1);
	expect(d.fragment).toBe(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s2",
	);
});

test("passive auto-open coalesces: the activation pushed, the auto-opened chat replaces in place", async () => {
	const d = fakeDriver("");
	const { listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	const store = useAppStore.getState();
	store.setWorkspaces(testProjectId("00000000-0000-4000-8000-0000000000a1"), [
		workspace("00000000-0000-4000-8000-0000000000b1"),
	]);
	store.activateWorkspace(workspace("00000000-0000-4000-8000-0000000000b1"));
	expect(d.pushes).toEqual([
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1",
	]);

	store.openChatSession(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		testSessionId("s1"),
		null,
		"medium",
		undefined,
		{
			activate: false,
		},
	);
	selectChatPlacement(testWorkspaceId("00000000-0000-4000-8000-0000000000b1"), testSessionId("s1"));
	expect(d.fragment).toBe(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s1",
	);
	expect(d.pushes).toEqual([
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1",
	]);
});

test("Back/Forward arrives as an incoming fragment: adopted and applied, never re-pushed", async () => {
	const d = fakeDriver("");
	const { calls, listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	const store = useAppStore.getState();
	store.setWorkspaces(testProjectId("00000000-0000-4000-8000-0000000000a1"), [
		workspace("00000000-0000-4000-8000-0000000000b1"),
		workspace("00000000-0000-4000-8000-0000000000b2"),
	]);
	store.activateWorkspace(workspace("00000000-0000-4000-8000-0000000000b1"));
	store.activateWorkspace(workspace("00000000-0000-4000-8000-0000000000b2"));
	expect(d.pushes).toEqual([
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1",
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b2",
	]);

	const pushesBefore = d.pushes.length;
	d.incoming(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1",
	);
	await settle();
	calls
		.at(-1)
		?.resolve([
			workspace("00000000-0000-4000-8000-0000000000b1"),
			workspace("00000000-0000-4000-8000-0000000000b2"),
		]);
	await settle();
	expect(useAppStore.getState().activeWorkspaceId).toBe(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
	);
	expect(d.pushes.length).toBe(pushesBefore);
	expect(d.fragment).toBe(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1",
	);
});

test("an armed push survives a momentarily underivable location and lands on its write", async () => {
	const d = fakeDriver("");
	const { listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	const store = useAppStore.getState();
	store.activateWorkspace(workspace("00000000-0000-4000-8000-0000000000b1"));
	expect(d.pushes).toEqual([]);
	store.setWorkspaces(testProjectId("00000000-0000-4000-8000-0000000000a1"), [
		workspace("00000000-0000-4000-8000-0000000000b1"),
	]);
	expect(d.pushes).toEqual([
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1",
	]);
});

test("a chat OPEN pushes once even though attention lands before the document commit", async () => {
	const d = fakeDriver("");
	const { listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	const store = useAppStore.getState();
	store.setWorkspaces(testProjectId("00000000-0000-4000-8000-0000000000a1"), [
		workspace("00000000-0000-4000-8000-0000000000b1"),
	]);
	store.activateWorkspace(workspace("00000000-0000-4000-8000-0000000000b1"));
	store.openChatSession(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		testSessionId("s1"),
		null,
		"medium",
	);
	placeChats(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		[testSessionId("s1")],
		"s1",
		1,
	);
	const pushesBefore = d.pushes.length;

	store.openChatSession(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		testSessionId("s2"),
		null,
		"medium",
	);
	useAppStore.setState((state) => ({
		layoutAttentionByWorkspace: {
			...state.layoutAttentionByWorkspace,
			"00000000-0000-4000-8000-0000000000b1": {
				selectedByGroup: { center: "placed:s2" },
				lastFocusedCenterGroupId: "center",
				lastFocusedSideGroupId: {},
				navigationClockByGroup: { center: 2 },
			},
		},
	}));
	expect(d.pushes.length).toBe(pushesBefore);
	useAppStore.setState((state) => {
		const document = state.layoutDocumentsByWorkspace["00000000-0000-4000-8000-0000000000b1"];
		if (document?.center.kind !== "group") throw new Error("unexpected layout");
		return {
			layoutDocumentsByWorkspace: {
				...state.layoutDocumentsByWorkspace,
				"00000000-0000-4000-8000-0000000000b1": {
					...document,
					center: {
						...document.center,
						tabs: [
							...document.center.tabs,
							{ kind: "chat", id: "placed:s2", name: "Chat", sessionId: testSessionId("s2") },
						],
					},
				},
			},
		};
	});
	expect(d.pushes.length).toBe(pushesBefore + 1);
	expect(d.fragment).toBe(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s2",
	);
});

test("removing the selected chat's placement (a close) pushes the neighbor location", async () => {
	const d = fakeDriver("");
	const { listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	const store = useAppStore.getState();
	store.setWorkspaces(testProjectId("00000000-0000-4000-8000-0000000000a1"), [
		workspace("00000000-0000-4000-8000-0000000000b1"),
	]);
	store.activateWorkspace(workspace("00000000-0000-4000-8000-0000000000b1"));
	store.openChatSession(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		testSessionId("s1"),
		null,
		"medium",
	);
	store.openChatSession(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		testSessionId("s2"),
		null,
		"medium",
	);
	placeChats(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		[testSessionId("s1"), testSessionId("s2")],
		"s2",
		1,
	);
	expect(d.fragment).toBe(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s2",
	);
	const pushesBefore = d.pushes.length;

	useAppStore.setState((state) => {
		const document = state.layoutDocumentsByWorkspace["00000000-0000-4000-8000-0000000000b1"];
		if (document?.center.kind !== "group") throw new Error("unexpected layout");
		return {
			layoutDocumentsByWorkspace: {
				...state.layoutDocumentsByWorkspace,
				"00000000-0000-4000-8000-0000000000b1": {
					...document,
					center: {
						...document.center,
						tabs: document.center.tabs.filter((tab) => tab.id !== "placed:s2"),
					},
				},
			},
		};
	});
	expect(d.pushes.length).toBe(pushesBefore + 1);
	expect(d.fragment).toBe(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s1",
	);
});

test("a deferred stamped open pushes its click's entry after the async round trip", async () => {
	const d = fakeDriver("");
	const { listWorkspaces } = fakeLists();
	stop = startNavigation({ driver: d.driver, listWorkspaces });
	installWelcome([project("00000000-0000-4000-8000-0000000000a1")]);
	const store = useAppStore.getState();
	store.setWorkspaces(testProjectId("00000000-0000-4000-8000-0000000000a1"), [
		workspace("00000000-0000-4000-8000-0000000000b1"),
	]);
	store.activateWorkspace(workspace("00000000-0000-4000-8000-0000000000b1"));
	store.openChatSession(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		testSessionId("s1"),
		null,
		"medium",
	);
	placeChats(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		[testSessionId("s1")],
		"s1",
		1,
	);
	const pushesBefore = d.pushes.length;

	const stamp = useAppStore
		.getState()
		.beginCenterNavigation(testWorkspaceId("00000000-0000-4000-8000-0000000000b1"), "center");
	expect(d.pushes.length).toBe(pushesBefore);
	await settle();
	const landed = useAppStore.getState();
	landed.openChatSession(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		testSessionId("s2"),
		null,
		"medium",
		undefined,
		layoutOpenOptionsForNavigation(
			landed,
			testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
			stamp,
		),
	);
	placeChats(
		testWorkspaceId("00000000-0000-4000-8000-0000000000b1"),
		[testSessionId("s1"), testSessionId("s2")],
		"s2",
	);
	expect(d.pushes.length).toBe(pushesBefore + 1);
	expect(d.fragment).toBe(
		"#/v1/projects/00000000-0000-4000-8000-0000000000a1/workspaces/00000000-0000-4000-8000-0000000000b1/chats/s2",
	);
});
