import type { LayoutPreset } from "@thinkrail/contracts";
import type {
	LayoutChangesTab,
	LayoutChatTab,
	LayoutDiffTab,
	LayoutDocumentTab,
	LayoutFileTab,
	LayoutTerminalTab,
	LayoutToolRestoreTarget,
	LayoutToolTab,
} from "./schema";

export type LayoutBottomAlignment = LayoutPreset["bottom"]["alignment"];
export type LayoutToolId = LayoutPreset["left"]["groups"][number]["tools"][number];

export type LayoutCenterTab =
	| LayoutFileTab
	| LayoutDiffTab
	| LayoutChangesTab
	| LayoutChatTab
	| LayoutDocumentTab
	| LayoutTerminalTab;
export type LayoutAuxiliaryTab = LayoutToolTab | LayoutTerminalTab;
export type LayoutSideTab = LayoutAuxiliaryTab;
export type LayoutTab = LayoutCenterTab | LayoutAuxiliaryTab;

export interface LayoutCenterGroup {
	kind: "group";
	id: string;
	tabs: LayoutCenterTab[];
	previewTabId?: string;
}

export interface LayoutCenterSplit {
	kind: "split";
	id: string;
	direction: "horizontal" | "vertical";
	weights: [number, number];
	children: [LayoutCenterNode, LayoutCenterNode];
}

export type LayoutCenterNode = LayoutCenterGroup | LayoutCenterSplit;

export interface LayoutSideGroup {
	id: string;
	weight: number;
	folded: boolean;
	tabs: LayoutAuxiliaryTab[];
}

export interface LayoutSideRegion {
	visible: boolean;
	width: number;
	groups: LayoutSideGroup[];
}

export interface LayoutBottomGroup {
	id: string;
	weight: number;
	folded: boolean;
	tabs: LayoutAuxiliaryTab[];
}

export interface LayoutBottomRegion {
	visible: boolean;
	height: number;
	alignment: LayoutBottomAlignment;
	groups: LayoutBottomGroup[];
}

export type { LayoutAuxiliaryRegion } from "./schema";

export interface WorkspaceLayoutDocument {
	version: 2;
	center: LayoutCenterNode;
	left: LayoutSideRegion;
	right: LayoutSideRegion;
	bottom: LayoutBottomRegion;
	toolRestoreTargets: Partial<Record<LayoutToolId, LayoutToolRestoreTarget>>;
}
