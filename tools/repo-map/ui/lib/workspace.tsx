import { createContext, type ReactNode, useContext } from "react";
import type { GraphDiff, GraphSide, RepoGraph, SessionInfo, SymbolId } from "../../core/types";
import { buildDiffIndex, type DiffIndex } from "./changes";
import { buildGraphIndex, type GraphIndex } from "./graphIndex";
import { buildPackageColors, type PackageColors } from "./packages";
import { buildSearchEntries, type SearchEntry } from "./search";

export interface Workspace {
	session: SessionInfo;
	head: GraphIndex;
	base?: GraphIndex;
	diff?: DiffIndex;
	packages: PackageColors;
	searchEntries: SearchEntry[];
}

export function buildWorkspace(input: {
	session: SessionInfo;
	head: RepoGraph;
	base?: RepoGraph | undefined;
	diff?: GraphDiff | undefined;
}): Workspace {
	const head = buildGraphIndex(input.head);
	const workspace: Workspace = {
		session: input.session,
		head,
		packages: buildPackageColors(input.head),
		searchEntries: buildSearchEntries(head),
	};
	return {
		...workspace,
		...(input.base ? { base: buildGraphIndex(input.base) } : {}),
		...(input.diff ? { diff: buildDiffIndex(input.diff) } : {}),
	};
}

const WorkspaceContext = createContext<Workspace | undefined>(undefined);

export function WorkspaceProvider(props: { value: Workspace; children: ReactNode }) {
	return (
		<WorkspaceContext.Provider value={props.value}>{props.children}</WorkspaceContext.Provider>
	);
}

export function useWorkspace() {
	const workspace = useContext(WorkspaceContext);
	if (!workspace) throw new Error("useWorkspace needs a WorkspaceProvider");
	return workspace;
}

export function useGraph(side: GraphSide) {
	const workspace = useWorkspace();
	return side === "base" && workspace.base ? workspace.base : workspace.head;
}

export function sideOfSymbol(workspace: Workspace, id: SymbolId | undefined): GraphSide {
	if (!id || workspace.head.symbols.has(id) || !workspace.base?.symbols.has(id)) return "head";
	return "base";
}
