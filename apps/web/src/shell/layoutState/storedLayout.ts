import { arr, compile, map, obj, opt, str, tuple, union, unknown } from "@earendil-works/pi-schema";
import { LayoutToolId, parseSessionId, StoredSessionId } from "@thinkrail/contracts";
import {
	LAYOUT_CHAT_TAB_FIELDS,
	LAYOUT_DOCUMENT_TAB_FIELDS,
	type LayoutCenterTab,
	LayoutChangesTab,
	LayoutFileTab,
	LayoutPinnedDiffTab,
	LayoutScopedDiffTab,
	LayoutTerminalTab,
	LayoutToolRestoreTarget,
	WORKBENCH_CENTER_SPLIT_FIELDS,
	WORKBENCH_FRAME_FIELDS,
	WorkbenchCenterGroup,
	type WorkbenchCenterNode,
	type WorkbenchFrame,
	type WorkspaceViewState,
} from "../layout";

const CenterGroup = compile(WorkbenchCenterGroup);
const CenterSplit = compile(
	obj({ ...WORKBENCH_CENTER_SPLIT_FIELDS, children: tuple([unknown(), unknown()]) }),
);

function parseCenter(node: unknown): WorkbenchCenterNode | null {
	if (CenterGroup.check(node)) return node;
	if (!CenterSplit.check(node)) return null;
	const first = parseCenter(node.children[0]);
	const second = parseCenter(node.children[1]);
	return first && second ? { ...node, children: [first, second] } : null;
}

const FrameShell = compile(
	obj({
		...WORKBENCH_FRAME_FIELDS,
		center: unknown(),
		toolRestoreTargets: map(LayoutToolRestoreTarget),
	}),
);
const isLayoutToolId = compile(LayoutToolId).check;

/** A stored frame with every field checked; any stray key or bad value refuses the whole frame. */
export function parseStoredFrame(value: unknown): WorkbenchFrame | null {
	if (!FrameShell.check(value)) return null;
	const center = parseCenter(value.center);
	if (!center) return null;
	const toolRestoreTargets: WorkbenchFrame["toolRestoreTargets"] = {};
	for (const [tool, { region, groupId, index }] of Object.entries(value.toolRestoreTargets)) {
		if (!isLayoutToolId(tool)) return null;
		const target: LayoutToolRestoreTarget =
			groupId === undefined ? { region, index } : { region, groupId, index };
		toolRestoreTargets[tool] = target;
	}
	return { ...value, center, toolRestoreTargets };
}

const SessionFreeTab = compile(union([LayoutFileTab, LayoutChangesTab, LayoutTerminalTab]));
const ScopedDiffTab = compile(LayoutScopedDiffTab);
const PinnedDiffTab = compile(LayoutPinnedDiffTab);
const StoredChatTab = compile(obj({ ...LAYOUT_CHAT_TAB_FIELDS, sessionId: StoredSessionId }));
const StoredDocumentTab = compile(
	obj({ ...LAYOUT_DOCUMENT_TAB_FIELDS, sourceId: StoredSessionId }),
);

/** A stored tab: the tab, `"set-aside"` when its stored session id cannot name a chat, or `null` when malformed. */
function parseCenterTab(tab: unknown): LayoutCenterTab | "set-aside" | null {
	if (SessionFreeTab.check(tab) || ScopedDiffTab.check(tab) || PinnedDiffTab.check(tab)) return tab;
	if (StoredChatTab.check(tab)) {
		const sessionId = parseSessionId(tab.sessionId);
		return sessionId ? { ...tab, sessionId } : "set-aside";
	}
	if (StoredDocumentTab.check(tab)) {
		const sourceId = parseSessionId(tab.sourceId);
		return sourceId ? { ...tab, sourceId } : "set-aside";
	}
	return null;
}

const GroupView = compile(
	obj({ tabs: arr(unknown()), previewTabId: opt(str()), beforeToolByTabId: opt(unknown()) }),
);
const ViewShell = compile(obj({ groups: map(unknown()) }));

export interface StoredView {
	view: WorkspaceViewState;
	/** Tabs left out because their stored session id is not one a request may name. */
	setAside: number;
}

/** A stored workspace view, keeping only each group's tabs and preview tab; a malformed tab refuses the view. */
export function parseStoredView(value: unknown): StoredView | null {
	if (!ViewShell.check(value)) return null;
	const groups: WorkspaceViewState["groups"] = {};
	let setAside = 0;
	for (const [groupId, group] of Object.entries(value.groups)) {
		if (!GroupView.check(group)) return null;
		const tabs: LayoutCenterTab[] = [];
		for (const candidate of group.tabs) {
			const tab = parseCenterTab(candidate);
			if (tab === null) return null;
			if (tab === "set-aside") setAside++;
			else tabs.push(tab);
		}
		groups[groupId] = group.previewTabId ? { tabs, previewTabId: group.previewTabId } : { tabs };
	}
	return { view: { groups }, setAside };
}
