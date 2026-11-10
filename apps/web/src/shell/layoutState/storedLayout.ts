import {
	arr,
	bool,
	compile,
	int,
	lit,
	map,
	num,
	obj,
	oneOf,
	opt,
	str,
	tuple,
	union,
	unknown,
} from "@earendil-works/pi-schema";
import { GitDiffScope, LayoutBottomAlignment, LayoutToolId, SessionId } from "@thinkrail/contracts";
import type {
	LayoutCenterTab,
	LayoutToolRestoreTarget,
	WorkbenchCenterNode,
	WorkbenchFrame,
	WorkspaceViewState,
} from "../layout";

const CenterGroup = compile(obj({ kind: lit("group"), id: str() }));
const CenterSplit = compile(
	obj({
		kind: lit("split"),
		id: str(),
		direction: oneOf(["horizontal", "vertical"]),
		weights: tuple([num(), num()]),
		children: tuple([unknown(), unknown()]),
	}),
);

function parseCenter(node: unknown): WorkbenchCenterNode | null {
	if (CenterGroup.check(node)) return node;
	if (!CenterSplit.check(node)) return null;
	const first = parseCenter(node.children[0]);
	const second = parseCenter(node.children[1]);
	return first && second ? { ...node, children: [first, second] } : null;
}

const AuxiliaryGroup = obj({
	id: str(),
	weight: num(),
	folded: bool(),
	tools: arr(obj({ kind: lit("tool"), id: str(), name: str(), tool: LayoutToolId })),
});
const RestoreTarget = obj({
	region: oneOf(["left", "right", "bottom"]),
	groupId: opt(str()),
	index: int({ minimum: 0 }),
});
const FrameShell = compile(
	obj({
		version: lit(1),
		center: unknown(),
		left: obj({ visible: bool(), width: num(), groups: arr(AuxiliaryGroup) }),
		right: obj({ visible: bool(), width: num(), groups: arr(AuxiliaryGroup) }),
		bottom: obj({
			visible: bool(),
			height: num(),
			alignment: LayoutBottomAlignment,
			groups: arr(AuxiliaryGroup),
		}),
		toolRestoreTargets: map(RestoreTarget),
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

const Tab = { id: str(), name: str() };
const SimpleCenterTab = compile(
	union([
		obj({ kind: lit("file"), ...Tab, path: str() }),
		obj({ kind: lit("changes"), ...Tab, scope: GitDiffScope }),
		obj({ kind: lit("chat"), ...Tab, sessionId: SessionId }),
		obj({
			kind: lit("document"),
			...Tab,
			documentKind: lit("todo-plan"),
			sourceId: SessionId,
			docPath: str(),
		}),
		obj({ kind: lit("terminal"), ...Tab, tabKey: str() }),
	]),
);
const ScopedDiffTab = compile(obj({ kind: lit("diff"), ...Tab, path: str(), scope: GitDiffScope }));
const PinnedDiffTab = compile(obj({ kind: lit("diff"), ...Tab, path: str(), before: str() }));

function parseCenterTab(tab: unknown): LayoutCenterTab | null {
	if (SimpleCenterTab.check(tab) || ScopedDiffTab.check(tab) || PinnedDiffTab.check(tab))
		return tab;
	return null;
}

const GroupView = compile(
	obj({ tabs: arr(unknown()), previewTabId: opt(str()), beforeToolByTabId: opt(unknown()) }),
);
const ViewShell = compile(obj({ groups: map(unknown()) }));

/** A stored workspace view, keeping only each group's tabs and preview tab. */
export function parseStoredView(value: unknown): WorkspaceViewState | null {
	if (!ViewShell.check(value)) return null;
	const groups: WorkspaceViewState["groups"] = {};
	for (const [groupId, group] of Object.entries(value.groups)) {
		if (!GroupView.check(group)) return null;
		const tabs: LayoutCenterTab[] = [];
		for (const candidate of group.tabs) {
			const tab = parseCenterTab(candidate);
			if (!tab) return null;
			tabs.push(tab);
		}
		groups[groupId] = group.previewTabId ? { tabs, previewTabId: group.previewTabId } : { tabs };
	}
	return { groups };
}
