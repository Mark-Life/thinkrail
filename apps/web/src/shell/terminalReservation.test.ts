import { beforeEach, expect, mock, test } from "bun:test";

const requests: { method: string; params: unknown }[] = [];
const actualTransport = await import("../transport");
mock.module("../transport", () => ({
	...actualTransport,
	getTransport: () => ({
		request: (method: string, params: unknown) => {
			requests.push({ method, params });
			return Promise.resolve(undefined);
		},
	}),
}));

const { useAppStore } = await import("../store");
const { settleTerminalReservation } = await import("./terminalReservation");

const workspaceId = "w1";
const terminals = () => useAppStore.getState().terminalsByWorkspace[workspaceId] ?? [];
const pendingKeys = () =>
	terminals()
		.filter((tab) => tab.reservationPending)
		.map((tab) => tab.tabKey);
const addPending = (): string => {
	useAppStore.getState().addTerminal(workspaceId, undefined, "bottom-a", "bottom");
	const tab = terminals().at(-1);
	if (!tab) throw new Error("missing pending terminal");
	return tab.tabKey;
};
const consumePlacement = (tabKey: string): void => {
	const intent = useAppStore
		.getState()
		.layoutIntents.find((entry) => entry.kind === "place-terminal" && entry.tabKey === tabKey);
	if (!intent) throw new Error("missing place-terminal intent");
	useAppStore.getState().consumeLayoutIntent(intent.id);
};

beforeEach(() => {
	requests.length = 0;
	useAppStore.setState({
		status: "connected",
		connectionGeneration: 1,
		removedWorkspaceIds: {},
		layoutIntents: [],
		layoutDocumentsByWorkspace: {},
		terminalsByWorkspace: {},
		activeTerminalByWorkspace: {},
	});
});

test("a reserve whose intent was consumed without a placement closes the host entry and drops the local one", () => {
	const first = addPending();
	const second = addPending();
	consumePlacement(first);

	settleTerminalReservation(workspaceId, first, 1, true);

	expect(requests).toEqual([
		{ method: "terminal.close", params: { workspaceId, tabKey: first, force: false } },
	]);
	expect(pendingKeys()).toEqual([second]);
});

test("a pending tab closed while disconnected is closed on the host when the reserve lands in a later generation", () => {
	const tabKey = addPending();
	consumePlacement(tabKey);
	useAppStore.getState().closeTerminalTab(workspaceId, tabKey, false);
	useAppStore.setState({ connectionGeneration: 2 });

	settleTerminalReservation(workspaceId, tabKey, 1, false);

	expect(requests).toEqual([
		{ method: "terminal.close", params: { workspaceId, tabKey, force: false } },
	]);
	expect(terminals()).toEqual([]);
});

test("a still-wanted reply from an older generation neither confirms nor closes", () => {
	const tabKey = addPending();
	useAppStore.setState({ connectionGeneration: 2 });

	settleTerminalReservation(workspaceId, tabKey, 1, true);

	expect(requests).toEqual([]);
	expect(pendingKeys()).toEqual([tabKey]);
});

test("a still-wanted reply in its own generation confirms the reservation", () => {
	const tabKey = addPending();

	settleTerminalReservation(workspaceId, tabKey, 1, true);

	expect(requests).toEqual([]);
	expect(pendingKeys()).toEqual([]);
	expect(terminals().map((tab) => tab.tabKey)).toEqual([tabKey]);
});

test("a removed workspace's reply is ignored", () => {
	const tabKey = addPending();
	consumePlacement(tabKey);
	useAppStore.setState({ removedWorkspaceIds: { [workspaceId]: true } });

	settleTerminalReservation(workspaceId, tabKey, 1, true);

	expect(requests).toEqual([]);
});
