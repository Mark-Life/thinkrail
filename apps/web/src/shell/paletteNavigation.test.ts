import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Project, ProjectId, Workspace } from "@thinkrail/contracts";
import { testProjectId, testWorkspaceId } from "@thinkrail/contracts/test-ids";
import { useAppStore } from "../store";
import { createPaletteNavigator } from "./paletteNavigation";

const project = (id: string): Project => ({
	id: testProjectId(id),
	name: id,
	path: `/repos/${id}`,
	slug: id,
	lastOpened: 0,
});

const workspace = (id: string, projectId: ProjectId): Workspace => ({
	id: testWorkspaceId(id),
	projectId,
	name: id,
	branch: id,
	baseBranch: "main",
	worktreePath: `/worktrees/${id}`,
});

const initial = useAppStore.getInitialState();

beforeEach(() => useAppStore.setState(initial, true));
afterEach(() => useAppStore.setState(initial, true));

function deferredLoader() {
	const pending = new Map<string, () => void>();
	const load = (projectId: ProjectId) =>
		new Promise<void>((resolve) => {
			pending.set(projectId, () => {
				useAppStore.getState().setWorkspaces(projectId, [workspace(`${projectId}-w`, projectId)]);
				resolve();
			});
		});
	return { load, finish: (projectId: ProjectId) => pending.get(projectId)?.() };
}

describe("palette navigation", () => {
	test("of two picks still loading, only the later one opens, whichever list lands first", async () => {
		useAppStore.setState({ projects: [project("pa"), project("pb")] });
		const loader = deferredLoader();
		const navigator = createPaletteNavigator(loader.load);
		const first = navigator.navigateToWorkspace({
			id: testWorkspaceId("pa-w"),
			projectId: testProjectId("pa"),
		});
		const second = navigator.navigateToWorkspace({
			id: testWorkspaceId("pb-w"),
			projectId: testProjectId("pb"),
		});
		loader.finish(testProjectId("pa"));
		expect(await first).toBe(false);
		expect(useAppStore.getState().activeWorkspaceId).toBeNull();
		loader.finish(testProjectId("pb"));
		expect(await second).toBe(true);
		expect(useAppStore.getState().activeWorkspaceId).toBe(testWorkspaceId("pb-w"));
	});

	test("a begun pick stops being wanted after a later pick or a navigation elsewhere, not when its own list lands", () => {
		useAppStore.setState({
			projects: [project("pa"), project("pb")],
			workspaces: { pb: [workspace("pb-w", testProjectId("pb"))] },
		});
		const navigator = createPaletteNavigator(deferredLoader().load);
		const overtaken = navigator.beginPick();
		const current = navigator.beginPick();
		expect(overtaken()).toBe(false);
		expect(current()).toBe(true);
		useAppStore
			.getState()
			.setWorkspaces(testProjectId("pa"), [workspace("pa-default", testProjectId("pa"))]);
		expect(current()).toBe(true);
		useAppStore
			.getState()
			.activateWorkspace({ id: testWorkspaceId("pb-w"), projectId: testProjectId("pb") });
		expect(current()).toBe(false);
	});

	test("a round trip away and back while a pick loads still drops the pick", async () => {
		useAppStore.setState({
			projects: [project("p1"), project("p2"), project("p3")],
			workspaces: {
				p2: [workspace("w2", testProjectId("p2")), workspace("w3", testProjectId("p2"))],
			},
		});
		useAppStore
			.getState()
			.activateWorkspace({ id: testWorkspaceId("w2"), projectId: testProjectId("p2") });
		const loader = deferredLoader();
		const navigator = createPaletteNavigator(loader.load);
		const workspaceTrip = navigator.navigateToWorkspace({
			id: testWorkspaceId("p1-w"),
			projectId: testProjectId("p1"),
		});
		useAppStore
			.getState()
			.activateWorkspace({ id: testWorkspaceId("w3"), projectId: testProjectId("p2") });
		useAppStore
			.getState()
			.activateWorkspace({ id: testWorkspaceId("w2"), projectId: testProjectId("p2") });
		loader.finish(testProjectId("p1"));
		expect(await workspaceTrip).toBe(false);
		expect(useAppStore.getState().activeWorkspaceId).toBe(testWorkspaceId("w2"));

		useAppStore.setState({ activeWorkspaceId: null, selectedProjectId: testProjectId("p2") });
		const homeTrip = navigator.navigateToWorkspace({
			id: testWorkspaceId("p3-w"),
			projectId: testProjectId("p3"),
		});
		useAppStore.getState().selectProject(testProjectId("p1"));
		useAppStore.getState().selectProject(testProjectId("p2"));
		loader.finish(testProjectId("p3"));
		expect(await homeTrip).toBe(false);
		expect(useAppStore.getState().activeWorkspaceId).toBeNull();
	});

	test("a workspace the store already holds opens at once", async () => {
		useAppStore.setState({
			projects: [project("p1")],
			workspaces: { p1: [workspace("w1", testProjectId("p1"))] },
		});
		const loader = deferredLoader();
		const navigator = createPaletteNavigator(loader.load);
		expect(
			await navigator.navigateToWorkspace({
				id: testWorkspaceId("w1"),
				projectId: testProjectId("p1"),
			}),
		).toBe(true);
		expect(useAppStore.getState().activeWorkspaceId).toBe(testWorkspaceId("w1"));
	});

	test("an unloaded workspace opens once its project's list lands", async () => {
		useAppStore.setState({ projects: [project("p1")] });
		const loader = deferredLoader();
		const navigator = createPaletteNavigator(loader.load);
		const opened = navigator.navigateToWorkspace({
			id: testWorkspaceId("p1-w"),
			projectId: testProjectId("p1"),
		});
		expect(useAppStore.getState().activeWorkspaceId).toBeNull();
		loader.finish(testProjectId("p1"));
		expect(await opened).toBe(true);
		expect(useAppStore.getState().activeWorkspaceId).toBe(testWorkspaceId("p1-w"));
	});

	test("a later pick or a navigation elsewhere wins over a pick still loading its project, a tab opening on its own does not", async () => {
		useAppStore.setState({
			projects: [project("p1"), project("p2")],
			workspaces: { p2: [workspace("w2", testProjectId("p2"))] },
		});
		const loader = deferredLoader();
		const navigator = createPaletteNavigator(loader.load);
		const stale = navigator.navigateToWorkspace({
			id: testWorkspaceId("p1-w"),
			projectId: testProjectId("p1"),
		});
		expect(
			await navigator.navigateToWorkspace({
				id: testWorkspaceId("w2"),
				projectId: testProjectId("p2"),
			}),
		).toBe(true);
		loader.finish(testProjectId("p1"));
		expect(await stale).toBe(false);
		expect(useAppStore.getState().activeWorkspaceId).toBe(testWorkspaceId("w2"));

		const late = navigator.navigateToWorkspace({
			id: testWorkspaceId("p1-y"),
			projectId: testProjectId("p1-tab"),
		});
		useAppStore.setState((state) => ({
			activeTabByWorkspace: { ...state.activeTabByWorkspace, w2: "a-chat-tab-that-just-opened" },
		}));
		loader.finish(testProjectId("p1-tab"));
		expect(await late).toBe(true);
		expect(useAppStore.getState().activeWorkspaceId).toBe(testWorkspaceId("p1-y"));

		useAppStore
			.getState()
			.activateWorkspaceFromRoute({ id: testWorkspaceId("w2"), projectId: testProjectId("p2") });
		const switched = navigator.navigateToWorkspace({
			id: testWorkspaceId("p1-z"),
			projectId: testProjectId("p1-switch"),
		});
		useAppStore.getState().noteNavigation(testWorkspaceId("w2"));
		loader.finish(testProjectId("p1-switch"));
		expect(await switched).toBe(false);
		expect(useAppStore.getState().activeWorkspaceId).toBe(testWorkspaceId("w2"));

		const again = navigator.navigateToWorkspace({
			id: testWorkspaceId("p1-x"),
			projectId: testProjectId("p1-later"),
		});
		useAppStore
			.getState()
			.activateWorkspaceFromRoute({ id: testWorkspaceId("w2"), projectId: testProjectId("p2") });
		useAppStore.setState({ selectedProjectId: testProjectId("p2"), activeWorkspaceId: null });
		loader.finish(testProjectId("p1-later"));
		expect(await again).toBe(false);
		expect(useAppStore.getState().activeWorkspaceId).toBeNull();
	});
});
