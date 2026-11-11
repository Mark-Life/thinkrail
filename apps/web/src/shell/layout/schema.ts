import {
	arr,
	bool,
	int,
	lit,
	num,
	obj,
	oneOf,
	opt,
	type Static,
	type StaticObject,
	str,
	tuple,
} from "@earendil-works/pi-schema";
import { GitDiffScope, LayoutBottomAlignment, LayoutToolId, SessionId } from "@thinkrail/contracts";

const TAB_FIELDS = { id: str(), name: str() };

export const LayoutFileTab = obj({ kind: lit("file"), ...TAB_FIELDS, path: str() });
export type LayoutFileTab = Static<typeof LayoutFileTab>;

export const LayoutScopedDiffTab = obj({
	kind: lit("diff"),
	...TAB_FIELDS,
	path: str(),
	scope: GitDiffScope,
});
export const LayoutPinnedDiffTab = obj({
	kind: lit("diff"),
	...TAB_FIELDS,
	path: str(),
	before: str(),
});
/** `before` tells the two apart, so the scoped tab types it as absent. */
export type LayoutDiffTab =
	| (Static<typeof LayoutScopedDiffTab> & { before?: undefined })
	| Static<typeof LayoutPinnedDiffTab>;

export const LayoutChangesTab = obj({ kind: lit("changes"), ...TAB_FIELDS, scope: GitDiffScope });
export type LayoutChangesTab = Static<typeof LayoutChangesTab>;

export const LAYOUT_CHAT_TAB_FIELDS = { kind: lit("chat"), ...TAB_FIELDS, sessionId: SessionId };
export const LayoutChatTab = obj(LAYOUT_CHAT_TAB_FIELDS);
export type LayoutChatTab = Static<typeof LayoutChatTab>;

export const LAYOUT_DOCUMENT_TAB_FIELDS = {
	kind: lit("document"),
	...TAB_FIELDS,
	documentKind: lit("todo-plan"),
	sourceId: SessionId,
	docPath: str(),
};
export const LayoutDocumentTab = obj(LAYOUT_DOCUMENT_TAB_FIELDS);
export type LayoutDocumentTab = Static<typeof LayoutDocumentTab>;

export const LayoutTerminalTab = obj({ kind: lit("terminal"), ...TAB_FIELDS, tabKey: str() });
export type LayoutTerminalTab = Static<typeof LayoutTerminalTab>;

export const LayoutToolTab = obj({ kind: lit("tool"), ...TAB_FIELDS, tool: LayoutToolId });
export type LayoutToolTab = Static<typeof LayoutToolTab>;

export const LayoutToolRestoreTarget = obj({
	region: oneOf(["left", "right", "bottom"]),
	groupId: opt(str()),
	index: int({ minimum: 0 }),
});
export type LayoutToolRestoreTarget = Static<typeof LayoutToolRestoreTarget>;

export const WorkbenchCenterGroup = obj({ kind: lit("group"), id: str() });
export type WorkbenchCenterGroup = Static<typeof WorkbenchCenterGroup>;

/** A center split's fields except `children`, which hold nodes of the same kind. */
export const WORKBENCH_CENTER_SPLIT_FIELDS = {
	kind: lit("split"),
	id: str(),
	direction: oneOf(["horizontal", "vertical"]),
	weights: tuple([num(), num()]),
};
export interface WorkbenchCenterSplit extends StaticObject<typeof WORKBENCH_CENTER_SPLIT_FIELDS> {
	children: [WorkbenchCenterNode, WorkbenchCenterNode];
}
export type WorkbenchCenterNode = WorkbenchCenterGroup | WorkbenchCenterSplit;

export const WorkbenchAuxiliaryGroup = obj({
	id: str(),
	weight: num(),
	folded: bool(),
	tools: arr(LayoutToolTab),
});
export type WorkbenchAuxiliaryGroup = Static<typeof WorkbenchAuxiliaryGroup>;

export const WorkbenchSideFrame = obj({
	visible: bool(),
	width: num(),
	groups: arr(WorkbenchAuxiliaryGroup),
});
export type WorkbenchSideFrame = Static<typeof WorkbenchSideFrame>;

export const WorkbenchBottomFrame = obj({
	visible: bool(),
	height: num(),
	alignment: LayoutBottomAlignment,
	groups: arr(WorkbenchAuxiliaryGroup),
});
export type WorkbenchBottomFrame = Static<typeof WorkbenchBottomFrame>;

/** A frame's fields except `center` and `toolRestoreTargets`, whose keys and nodes a schema cannot type. */
export const WORKBENCH_FRAME_FIELDS = {
	version: lit(1),
	left: WorkbenchSideFrame,
	right: WorkbenchSideFrame,
	bottom: WorkbenchBottomFrame,
};
export interface WorkbenchFrame extends StaticObject<typeof WORKBENCH_FRAME_FIELDS> {
	center: WorkbenchCenterNode;
	toolRestoreTargets: Partial<Record<LayoutToolId, LayoutToolRestoreTarget>>;
}
