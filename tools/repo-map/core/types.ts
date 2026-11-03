export const GRAPH_SCHEMA_VERSION = 1;

export type SymbolId = string & { readonly __brand: "SymbolId" };

export type SymbolKind =
	| "function"
	| "method"
	| "component"
	| "hook"
	| "class"
	| "interface"
	| "type"
	| "enum"
	| "wire-handler"
	| "tool"
	| "const"
	| "module";

export interface CodeSymbol {
	id: SymbolId;
	name: string;
	kind: SymbolKind;
	file: string;
	module: string;
	startLine: number;
	endLine: number;
	exported: boolean;
	barrelExported: boolean;
	isTest: boolean;
	bodyHash: string;
	signatureHash: string;
	signature: string;
	parent?: SymbolId;
}

export type EdgeKind =
	| "call"
	| "new"
	| "render"
	| "type-ref"
	| "implements"
	| "wire-request"
	| "wire-push"
	| "tool-render";

export interface Edge {
	from: SymbolId;
	to: SymbolId;
	kind: EdgeKind;
	line: number;
	count: number;
	label?: string;
}

export interface FileInfo {
	path: string;
	module: string;
	lines: number;
	isTest: boolean;
	commits90d: number;
	imports: string[];
	contentHash: string;
	tokenHash: string;
}

export interface ModuleInfo {
	path: string;
	title?: string;
	responsibility?: string;
	lines: number;
	files: number;
}

export interface ModuleEdge {
	from: string;
	to: string;
	imports: number;
}

export interface IndexStats {
	files: number;
	callSites: number;
	resolvedInRepo: number;
	resolvedExternal: number;
	unresolved: number;
	dynamicCalls: number;
	wireMethods: number;
	wireMethodsWithHandler: number;
	wireMethodsWithCaller: number;
	wireDynamicRequests: number;
	wireUnhandledRequests: number;
	wireChannels: number;
	wireChannelsLinked: number;
	tools: number;
	toolRenderers: number;
	toolsLinked: number;
	durationMs: number;
}

export type GraphRef =
	| { kind: "commit"; sha: string }
	| { kind: "worktree"; sha: string; dirtyFiles: string[] };

export interface RepoGraph {
	schemaVersion: typeof GRAPH_SCHEMA_VERSION;
	ref: GraphRef;
	symbols: CodeSymbol[];
	edges: Edge[];
	files: FileInfo[];
	modules: ModuleInfo[];
	moduleEdges: ModuleEdge[];
	stats: IndexStats;
}

export type SymbolChange =
	| { kind: "added"; head: SymbolId }
	| { kind: "removed"; base: SymbolId }
	| { kind: "modified"; base: SymbolId; head: SymbolId; signatureChanged: boolean }
	| { kind: "moved"; base: SymbolId; head: SymbolId };

export interface EdgeChange {
	kind: "added" | "removed";
	edge: Edge;
}

export type ContractChange =
	| { kind: "export-added" | "export-removed"; symbol: SymbolId }
	| { kind: "signature-changed"; symbol: SymbolId; before: string; after: string }
	| { kind: "wire-method-added" | "wire-method-removed"; method: string }
	| { kind: "module-dependency-added" | "module-dependency-removed"; from: string; to: string };

export interface BlastRadius {
	callers: SymbolId[];
	entryPoints: SymbolId[];
	tests: SymbolId[];
	truncated: boolean;
}

export interface ChangeGroup {
	id: string;
	title: string;
	symbolChanges: SymbolChange[];
	edgeChanges: EdgeChange[];
	blast: BlastRadius;
}

export interface GraphDiff {
	groups: ChangeGroup[];
	contracts: ContractChange[];
	movedOnly: SymbolChange[];
	formatOnlyFiles: string[];
	changedFiles: string[];
	nonCodeFiles: string[];
}

export type SessionInfo =
	| { mode: "map"; repoName: string; head: GraphRef }
	| {
			mode: "diff";
			repoName: string;
			title: string;
			base: GraphRef;
			head: GraphRef;
	  };

export type GraphSide = "base" | "head";
