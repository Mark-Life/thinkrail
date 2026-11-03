import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Project, ProjectId, Workspace } from "@thinkrail/contracts";
import { asProjectId, asWorkspaceId } from "@thinkrail/contracts";
import { useAppStore } from "../store";
import { createPaletteNavigator } from "./paletteNavigation";

const project = (id: string): Project => ({
	id: asProjectId(id),
	name: id,
	path: `/repos/${id}`,
	slug: id,
	lastOpened: 0,
});

const workspace = (id: string, projectId: ProjectId): Workspace => ({
	id: asWorkspaceId(id),
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
			id: asWorkspaceId("pa-w"),
			projectId: asProjectId("pa"),
		});
		const second = navigator.navigateToWorkspace({
			id: asWorkspaceId("pb-w"),
			projectId: asProjectId("pb"),
		});
		loader.finish(asProjectId("pa"));
		expect(await first).toBe(false);
		expect(useAppStore.getState().activeWorkspaceId).toBeNull();
		loader.finish(asProjectId("pb"));
		expect(await second).toBe(true);
		expect(useAppStore.getState().activeWorkspaceId).toBe(asWorkspaceId("pb-w"));
	});

	test("a begun pick stops being wanted after a later pick or a navigation elsewhere, not when its own list lands", () => {
		useAppStore.setState({
			projects: [project("pa"), project("pb")],
			workspaces: { pb: [workspace("pb-w", asProjectId("pb"))] },
		});
		const navigator = createPaletteNavigator(deferredLoader().load);
		const overtaken = navigator.beginPick();
		const current = navigator.beginPick();
		expect(overtaken()).toBe(false);
		expect(current()).toBe(true);
		useAppStore
			.getState()
			.setWorkspaces(asProjectId("pa"), [workspace("pa-default", asProjectId("pa"))]);
		expect(current()).toBe(true);
		useAppStore
			.getState()
			.activateWorkspace({ id: asWorkspaceId("pb-w"), projectId: asProjectId("pb") });
		expect(current()).toBe(false);
	});

	test("a round trip away and back while a pick loads still drops the pick", async () => {
		useAppStore.setState({
			projects: [project("p1"), project("p2"), project("p3")],
			workspaces: { p2: [workspace("w2", asProjectId("p2")), workspace("w3", asProjectId("p2"))] },
		});
		useAppStore
			.getState()
			.activateWorkspace({ id: asWorkspaceId("w2"), projectId: asProjectId("p2") });
		const loader = deferredLoader();
		const navigator = createPaletteNavigator(loader.load);
		const workspaceTrip = navigator.navigateToWorkspace({
			id: asWorkspaceId("p1-w"),
			projectId: asProjectId("p1"),
		});
		useAppStore
			.getState()
			.activateWorkspace({ id: asWorkspaceId("w3"), projectId: asProjectId("p2") });
		useAppStore
			.getState()
			.activateWorkspace({ id: asWorkspaceId("w2"), projectId: asProjectId("p2") });
		loader.finish(asProjectId("p1"));
		expect(await workspaceTrip).toBe(false);
		expect(useAppStore.getState().activeWorkspaceId).toBe(asWorkspaceId("w2"));

		useAppStore.setState({ activeWorkspaceId: null, selectedProjectId: asProjectId("p2") });
		const homeTrip = navigator.navigateToWorkspace({
			id: asWorkspaceId("p3-w"),
			projectId: asProjectId("p3"),
		});
		useAppStore.getState().selectProject(asProjectId("p1"));
		useAppStore.getState().selectProject(asProjectId("p2"));
		loader.finish(asProjectId("p3"));
		expect(await homeTrip).toBe(false);
		expect(useAppStore.getState().activeWorkspaceId).toBeNull();
	});

	test("a workspace the store already holds opens at once", async () => {
		useAppStore.setState({
			projects: [project("p1")],
			workspaces: { p1: [workspace("w1", asProjectId("p1"))] },
		});
		const loader = deferredLoader();
		const navigator = createPaletteNavigator(loader.load);
		expect(
			await navigator.navigateToWorkspace({
				id: asWorkspaceId("w1"),
				projectId: asProjectId("p1"),
			}),
		).toBe(true);
		expect(useAppStore.getState().activeWorkspaceId).toBe(asWorkspaceId("w1"));
	});

	test("an unloaded workspace opens once its project's list lands", async () => {
		useAppStore.setState({ projects: [project("p1")] });
		const loader = deferredLoader();
		const navigator = createPaletteNavigator(loader.load);
		const opened = navigator.navigateToWorkspace({
			id: asWorkspaceId("p1-w"),
			projectId: asProjectId("p1"),
		});
		expect(useAppStore.getState().activeWorkspaceId).toBeNull();
		loader.finish(asProjectId("p1"));
		expect(await opened).toBe(true);
		expect(useAppStore.getState().activeWorkspaceId).toBe(asWorkspaceId("p1-w"));
	});

	test("a later pick or a navigation elsewhere wins over a pick still loading its project, a tab opening on its own does not", async () => {
		useAppStore.setState({
			projects: [project("p1"), project("p2")],
			workspaces: { p2: [workspace("w2", asProjectId("p2"))] },
		});
		const loader = deferredLoader();
		const navigator = createPaletteNavigator(loader.load);
		const stale = navigator.navigateToWorkspace({
			id: asWorkspaceId("p1-w"),
			projectId: asProjectId("p1"),
		});
		expect(
			await navigator.navigateToWorkspace({
				id: asWorkspaceId("w2"),
				projectId: asProjectId("p2"),
			}),
		).toBe(true);
		loader.finish(asProjectId("p1"));
		expect(await stale).toBe(false);
		expect(useAppStore.getState().activeWorkspaceId).toBe(asWorkspaceId("w2"));

		const late = navigator.navigateToWorkspace({
			id: asWorkspaceId("p1-y"),
			projectId: asProjectId("p1-tab"),
		});
		useAppStore.setState((state) => ({
			activeTabByWorkspace: { ...state.activeTabByWorkspace, w2: "a-chat-tab-that-just-opened" },
		}));
		loader.finish(asProjectId("p1-tab"));
		expect(await late).toBe(true);
		expect(useAppStore.getState().activeWorkspaceId).toBe(asWorkspaceId("p1-y"));

		useAppStore
			.getState()
			.activateWorkspaceFromRoute({ id: asWorkspaceId("w2"), projectId: asProjectId("p2") });
		const switched = navigator.navigateToWorkspace({
			id: asWorkspaceId("p1-z"),
			projectId: asProjectId("p1-switch"),
		});
		useAppStore.getState().noteNavigation(asWorkspaceId("w2"));
		loader.finish(asProjectId("p1-switch"));
		expect(await switched).toBe(false);
		expect(useAppStore.getState().activeWorkspaceId).toBe(asWorkspaceId("w2"));

		const again = navigator.navigateToWorkspace({
			id: asWorkspaceId("p1-x"),
			projectId: asProjectId("p1-later"),
		});
		useAppStore
			.getState()
			.activateWorkspaceFromRoute({ id: asWorkspaceId("w2"), projectId: asProjectId("p2") });
		useAppStore.setState({ selectedProjectId: asProjectId("p2"), activeWorkspaceId: null });
		loader.finish(asProjectId("p1-later"));
		expect(await again).toBe(false);
		expect(useAppStore.getState().activeWorkspaceId).toBeNull();
	});
});
