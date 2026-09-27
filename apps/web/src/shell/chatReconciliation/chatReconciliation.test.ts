import { expect, test } from "bun:test";
import type { WorkspaceLayoutDocument } from "../layout";
import { catalogBaselines } from "./chatReconciliation";

function documentWithChats(sessionIds: string[]): WorkspaceLayoutDocument {
	return {
		version: 2,
		center: {
			kind: "group",
			id: "center-a",
			tabs: sessionIds.map((sessionId) => ({
				kind: "chat",
				id: `ws1:chat:${sessionId}`,
				name: "Chat",
				sessionId,
			})),
		},
		left: { visible: false, width: 0.2, groups: [] },
		right: { visible: false, width: 0.2, groups: [] },
		bottom: { visible: false, height: 0.3, alignment: "center", groups: [] },
		toolRestoreTargets: {},
	};
}

test("catalog baselines leave a pending chat out, placed or closed to history, so the session list cannot tombstone it", () => {
	const chat = (sessionId: string) => ({
		kind: "chat" as const,
		id: `ws1:chat:${sessionId}`,
		workspaceId: "ws1",
		name: "Chat",
		sessionId,
	});
	const state = {
		tabsByWorkspace: { ws1: [chat("settled"), chat("starting")] },
		closedChatsByWorkspace: {
			ws1: [
				{ sessionId: "closed", title: "Old", closedAt: 1 },
				{ sessionId: "closed-starting", title: "New chat", closedAt: 2 },
			],
		},
		layoutDocumentsByWorkspace: { ws1: documentWithChats(["settled", "starting"]) },
		sessions: {
			starting: { pending: true as const },
			"closed-starting": { pending: true as const },
			settled: {},
		},
	};
	expect(catalogBaselines(state, "ws1")).toEqual({
		baselineSessionIds: ["settled", "closed"],
		baselinePlacedSessionIds: ["settled"],
	});
});
