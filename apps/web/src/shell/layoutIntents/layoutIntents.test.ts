import { describe, expect, test } from "bun:test";
import type { LayoutAttention } from "../../lib";
import { type LayoutIntentTransition, useAppStore } from "../../store";
import type { LayoutTerminalTab, WorkspaceLayoutDocument } from "../layout";
import { findTabLocation } from "../layout";
import { terminalLayoutId } from "../terminalReconciliation";
import { createLayoutIntentDrain, placeTerminalForIntent } from "./layoutIntents";

function document(): WorkspaceLayoutDocument {
	return {
		version: 2,
		center: { kind: "group", id: "center", tabs: [] },
		left: { visible: false, width: 0.18, groups: [] },
		right: { visible: false, width: 0.28, groups: [] },
		bottom: {
			visible: false,
			height: 0.3,
			alignment: "center",
			groups: [
				{ id: "bottom-one", weight: 0.5, folded: false, tabs: [] },
				{ id: "bottom-two", weight: 0.5, folded: true, tabs: [] },
			],
		},
		toolRestoreTargets: {},
	};
}

const attention: LayoutAttention = {
	selectedByGroup: {},
	lastFocusedCenterGroupId: "center",
	lastFocusedSideGroupId: { bottom: "bottom-two" },
	navigationClockByGroup: { center: 0 },
};

const terminal: LayoutTerminalTab = {
	kind: "terminal",
	id: "terminal:new",
	name: "Terminal 1",
	tabKey: "new",
};

const limits = { maxSideGroups: 6, maxBottomGroups: 3 } as const;

describe("terminal intent routing", () => {
	test("global creation uses and reveals the last-focused surviving bottom group", () => {
		const result = placeTerminalForIntent(document(), attention, terminal, undefined, limits);
		if ("reason" in result) throw new Error(result.reason);
		expect(findTabLocation(result.document, terminal.id)).toEqual({
			area: "bottom",
			groupId: "bottom-two",
		});
		expect(result.document.bottom.visible).toBe(true);
		expect(result.document.bottom.groups[1]?.folded).toBe(false);
	});

	test("a reserved hidden default keeps its captured bottom geometry and does not request focus", () => {
		const result = placeTerminalForIntent(
			document(),
			attention,
			terminal,
			{ area: "bottom", groupId: "bottom-two" },
			limits,
			false,
		);
		if ("reason" in result) throw new Error(result.reason);
		expect(findTabLocation(result.document, terminal.id)).toEqual({
			area: "bottom",
			groupId: "bottom-two",
		});
		expect(result.document.bottom.visible).toBe(false);
		expect(result.document.bottom.groups[1]?.folded).toBe(true);
		expect(result.focusGroupId).toBeUndefined();
		expect(result.focusTabId).toBeUndefined();

		const withoutSlot = document();
		withoutSlot.bottom.groups = [];
		const created = placeTerminalForIntent(
			withoutSlot,
			attention,
			terminal,
			undefined,
			limits,
			false,
		);
		if ("reason" in created) throw new Error(created.reason);
		expect(created.document.bottom.visible).toBe(false);
		expect(created.document.bottom.groups).toHaveLength(1);
		expect(findTabLocation(created.document, terminal.id)?.area).toBe("bottom");
		expect(created.focusGroupId).toBeUndefined();
	});

	test("global creation makes a bottom slot while an explicit center target stays center", () => {
		const empty = document();
		empty.bottom.groups = [];
		const created = placeTerminalForIntent(empty, attention, terminal, undefined, limits);
		if ("reason" in created) throw new Error(created.reason);
		expect(findTabLocation(created.document, terminal.id)?.area).toBe("bottom");
		expect(created.document.bottom.groups).toHaveLength(1);

		const centered = placeTerminalForIntent(
			document(),
			attention,
			terminal,
			{ area: "center", groupId: "center" },
			limits,
		);
		if ("reason" in centered) throw new Error(centered.reason);
		expect(findTabLocation(centered.document, terminal.id)?.area).toBe("center");
	});
});

describe("layout intent drain", () => {
	const workspaceId = "ws-drain";
	const seed = (): void => {
		useAppStore.setState({
			removedWorkspaceIds: {},
			layoutIntents: [],
			layoutDocumentsByWorkspace: { [workspaceId]: document() },
			layoutAttentionByWorkspace: { [workspaceId]: attention },
			localLayoutPreferences: { defaultPresetId: "balanced", maxSideGroups: 6, maxBottomGroups: 3 },
			terminalsByWorkspace: {},
			activeTerminalByWorkspace: {},
			historyOpenRequest: null,
		});
	};
	const install = (transition: LayoutIntentTransition): void =>
		useAppStore.setState((state) => ({
			layoutDocumentsByWorkspace: transition.document
				? { ...state.layoutDocumentsByWorkspace, [workspaceId]: transition.document }
				: state.layoutDocumentsByWorkspace,
			layoutAttentionByWorkspace: transition.attention
				? { ...state.layoutAttentionByWorkspace, [workspaceId]: transition.attention }
				: state.layoutAttentionByWorkspace,
			layoutIntents: state.layoutIntents.filter((intent) => intent.id !== transition.intentId),
		}));
	const currentDocument = () => {
		const current = useAppStore.getState().layoutDocumentsByWorkspace[workspaceId];
		if (!current) throw new Error("document missing");
		return current;
	};

	test("a reservation-pending terminal is placed inside the enqueuing set, before host confirmation", () => {
		seed();
		const unsubscribe = useAppStore.subscribe(
			createLayoutIntentDrain(workspaceId, install, () => {}),
		);
		try {
			useAppStore.getState().addTerminal(workspaceId, undefined, undefined, "bottom");
			const tab = useAppStore.getState().terminalsByWorkspace[workspaceId]?.[0];
			if (!tab) throw new Error("terminal missing");
			expect(tab.reservationPending).toBe(true);
			expect(findTabLocation(currentDocument(), terminalLayoutId(tab.tabKey))?.area).toBe("bottom");
			expect(useAppStore.getState().layoutIntents).toEqual([]);
		} finally {
			unsubscribe();
		}
	});

	test("a follow-up intent enqueued while draining is handled in the same drain", () => {
		seed();
		const unsubscribe = useAppStore.subscribe(
			createLayoutIntentDrain(workspaceId, install, () => {}),
		);
		try {
			useAppStore.getState().enqueueLayoutIntent({ kind: "toggle-bottom", workspaceId });
			const next = currentDocument();
			expect(next.bottom.visible).toBe(true);
			const terminals = useAppStore.getState().terminalsByWorkspace[workspaceId] ?? [];
			expect(terminals).toHaveLength(1);
			const tabKey = terminals[0]?.tabKey ?? "";
			expect(findTabLocation(next, terminalLayoutId(tabKey))?.area).toBe("bottom");
			expect(useAppStore.getState().layoutIntents).toEqual([]);
		} finally {
			unsubscribe();
		}
	});

	test("a transition that throws consumes its intent so later intents still drain", () => {
		seed();
		let failNext = true;
		const flaky = (transition: LayoutIntentTransition): void => {
			if (failNext) {
				failNext = false;
				throw new Error("commit failed");
			}
			install(transition);
		};
		const unsubscribe = useAppStore.subscribe(
			createLayoutIntentDrain(workspaceId, flaky, () => {}),
		);
		try {
			expect(() =>
				useAppStore.getState().enqueueLayoutIntent({ kind: "toggle-bottom", workspaceId }),
			).toThrow("commit failed");
			expect(useAppStore.getState().layoutIntents).toEqual([]);
			expect(currentDocument().bottom.visible).toBe(false);
			useAppStore.getState().enqueueLayoutIntent({ kind: "toggle-bottom", workspaceId });
			expect(currentDocument().bottom.visible).toBe(true);
			expect(useAppStore.getState().layoutIntents).toEqual([]);
		} finally {
			unsubscribe();
		}
	});
});
