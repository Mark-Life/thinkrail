import { afterEach, beforeEach, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@thinkrail/contracts";
import { testWorkspaceId } from "@thinkrail/contracts/test-ids";
import { useAppStore } from "../store";
import { PALETTE_PREVIEW_HOST } from "./AppResourceHost";

const initial = useAppStore.getInitialState();

beforeEach(() => useAppStore.setState(initial, true));
afterEach(() => useAppStore.setState(initial, true));

const welcome = (protocolVersion: number) =>
	useAppStore.setState((state) => ({
		protocolVersion,
		welcomeProtocolVersion: protocolVersion,
		welcomeGeneration: state.welcomeGeneration + 1,
	}));

test("the palette's preview host reads and refreshes only once the current host serves capped reads", async () => {
	const refreshes: (readonly string[] | null)[] = [];
	const stop = PALETTE_PREVIEW_HOST.subscribeFileChanges(testWorkspaceId("w1"), (paths) =>
		refreshes.push(paths),
	);
	try {
		useAppStore.setState({ status: "connected", connectionGeneration: 1 });
		expect(refreshes).toEqual([]);
		await expect(PALETTE_PREVIEW_HOST.readFile(testWorkspaceId("w1"), "a.ts")).rejects.toThrow(
			"Reconnect",
		);
		welcome(PROTOCOL_VERSION);
		expect(refreshes).toEqual([null]);

		useAppStore.setState({ status: "disconnected", protocolVersion: null });
		useAppStore.setState({ status: "connected", connectionGeneration: 2 });
		expect(refreshes).toEqual([null]);
		expect(refreshes).toEqual([null]);
		await expect(PALETTE_PREVIEW_HOST.readFile(testWorkspaceId("w1"), "a.ts")).rejects.toThrow(
			"Reconnect",
		);
	} finally {
		stop();
	}
});
