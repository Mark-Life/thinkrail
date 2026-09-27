import { isConnectedGeneration, useAppStore } from "../store";
import { getTransport } from "../transport";
import { collectAllGroups } from "./layout";

type AppState = ReturnType<typeof useAppStore.getState>;

export function terminalStillWanted(state: AppState, workspaceId: string, tabKey: string): boolean {
	const document = state.layoutDocumentsByWorkspace[workspaceId];
	const placed =
		document !== undefined &&
		collectAllGroups(document)
			.flatMap((group) => group.tabs)
			.some((tab) => tab.kind === "terminal" && tab.tabKey === tabKey);
	return (
		placed ||
		state.layoutIntents.some(
			(intent) =>
				intent.kind === "place-terminal" &&
				intent.workspaceId === workspaceId &&
				intent.tabKey === tabKey,
		)
	);
}

export function settleTerminalReservation(
	workspaceId: string,
	tabKey: string,
	connectionGeneration: number,
	current: boolean,
): void {
	const state = useAppStore.getState();
	if (state.removedWorkspaceIds[workspaceId]) return;
	if (!terminalStillWanted(state, workspaceId, tabKey)) {
		void getTransport()
			.request("terminal.close", { workspaceId, tabKey, force: false })
			.catch(() => {});
		state.closeTerminalTab(workspaceId, tabKey, false);
		return;
	}
	if (!current || !isConnectedGeneration(state, connectionGeneration)) return;
	state.confirmTerminalReservation(workspaceId, tabKey);
}
