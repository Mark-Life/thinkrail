import { afterEach, beforeEach, expect, test } from "bun:test";
import { SEARCH_PROTOCOL_VERSION } from "@thinkrail/contracts";
import { useAppStore } from "../store";
import { PALETTE_PREVIEW_HOST } from "./AppResourceHost";
import { mockupHtmlMode } from "./mockupScripts";

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
	const stop = PALETTE_PREVIEW_HOST.subscribeFileChanges("w1", (paths) => refreshes.push(paths));
	try {
		useAppStore.setState({ status: "connected", connectionGeneration: 1 });
		expect(refreshes).toEqual([]);
		await expect(PALETTE_PREVIEW_HOST.readFile("w1", "a.ts")).rejects.toThrow("Reconnect");
		welcome(SEARCH_PROTOCOL_VERSION);
		expect(refreshes).toEqual([null]);

		useAppStore.setState({ status: "disconnected", protocolVersion: null });
		useAppStore.setState({ status: "connected", connectionGeneration: 2 });
		expect(refreshes).toEqual([null]);
		welcome(SEARCH_PROTOCOL_VERSION - 1);
		expect(refreshes).toEqual([null]);
		await expect(PALETTE_PREVIEW_HOST.readFile("w1", "a.ts")).rejects.toThrow("Reconnect");
	} finally {
		stop();
	}
});

test("the palette's preview host never answers scripted, also for a mockup the agent showed", () => {
	const mockup = ".thinkrail/context/mockups/chart.html";
	const call = {
		type: "toolCall",
		id: "call-1",
		name: "visualize",
		arguments: { type: "file", path: mockup },
	};
	useAppStore.setState({
		tabsByWorkspace: { w1: [{ kind: "chat", id: "tab-1", sessionId: "s1", name: "Chat" }] },
		sessions: {
			s1: {
				turns: [{ kind: "assistant", id: "a1", message: { role: "assistant", content: [call] } }],
				toolResults: { "call-1": { status: "done" } },
			},
		},
	} as unknown as Partial<typeof initial>);
	expect(mockupHtmlMode(useAppStore.getState(), "w1", mockup)).toBe("scripted");
	expect(PALETTE_PREVIEW_HOST.html?.mode("w1", mockup)).toBe("themed");
	expect(PALETTE_PREVIEW_HOST.html?.subscribe).toBeUndefined();
	expect(PALETTE_PREVIEW_HOST.html?.mode("w1", "index.html")).toBe("static");
});
