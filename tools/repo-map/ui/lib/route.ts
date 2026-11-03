import type { GraphSide, SymbolId } from "../../core/types";

export type ChangesTab = "calls" | "blast" | "source";
type ChangesSection = "groups" | "contracts" | "moved" | "non-code";

export interface MapRoute {
	view: "map";
	path?: string;
	file?: string;
	tests: boolean;
}

export interface TraceRoute {
	view: "trace";
	symbol?: SymbolId;
	side: GraphSide;
	expanded: string[];
	revealed: string[];
	types: boolean;
	tests: boolean;
}

export type FlowLayout = "waterfall" | "sequence";

export interface FlowRoute {
	view: "flow";
	layout: FlowLayout;
	symbol?: SymbolId;
	side: GraphSide;
	depth: number;
	selected?: SymbolId;
	utilities: boolean;
}

export interface SymbolRoute {
	view: "symbol";
	symbol: SymbolId;
	side: GraphSide;
}

export interface FileRoute {
	view: "file";
	file: string;
	side: GraphSide;
	line?: number;
}

export interface ChangesRoute {
	view: "changes";
	section: ChangesSection;
	group?: string;
	tab: ChangesTab;
	symbol?: SymbolId;
}

export type Route = MapRoute | TraceRoute | FlowRoute | SymbolRoute | FileRoute | ChangesRoute;

export const DEFAULT_FLOW_DEPTH = 3;
export const MIN_FLOW_DEPTH = 1;
export const MAX_FLOW_DEPTH = 8;

function sideParam(value: string | null): GraphSide {
	return value === "base" ? "base" : "head";
}

function listParam(value: string | null) {
	return value ? value.split("\n") : [];
}

function symbolParam(value: string | null) {
	return value ? (value as SymbolId) : undefined;
}

function depthParam(value: string | null) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || value === null) return DEFAULT_FLOW_DEPTH;
	return Math.min(MAX_FLOW_DEPTH, Math.max(MIN_FLOW_DEPTH, parsed));
}

function tabParam(value: string | null): ChangesTab {
	return value === "blast" || value === "source" ? value : "calls";
}

function sectionParam(value: string | null): ChangesSection {
	return value === "contracts" || value === "moved" || value === "non-code" ? value : "groups";
}

function withOptional<T extends object, K extends string, V>(
	target: T,
	key: K,
	value: V | undefined,
) {
	return value === undefined ? target : { ...target, [key]: value };
}

export function parseHash(hash: string, fallback: Route): Route {
	const raw = hash.replace(/^#\/?/, "");
	if (!raw) return fallback;
	const [view, query = ""] = raw.split("?", 2);
	const params = new URLSearchParams(query);
	const symbol = symbolParam(params.get("s"));
	const side = sideParam(params.get("side"));
	switch (view) {
		case "map": {
			const base: MapRoute = { view: "map", tests: params.get("tests") === "1" };
			const path = params.get("p") ?? undefined;
			const file = params.get("f") ?? undefined;
			return withOptional(withOptional(base, "path", path), "file", file);
		}
		case "trace": {
			const base: TraceRoute = {
				view: "trace",
				side,
				expanded: listParam(params.get("x")),
				revealed: listParam(params.get("r")),
				types: params.get("types") === "1",
				tests: params.get("tests") === "1",
			};
			return withOptional(base, "symbol", symbol);
		}
		case "flow": {
			const base: FlowRoute = {
				view: "flow",
				layout: params.get("layout") === "sequence" ? "sequence" : "waterfall",
				side,
				depth: depthParam(params.get("d")),
				utilities: params.get("utils") === "1",
			};
			return withOptional(
				withOptional(base, "symbol", symbol),
				"selected",
				symbolParam(params.get("sel")),
			);
		}
		case "symbol":
			return symbol ? { view: "symbol", symbol, side } : fallback;
		case "file": {
			const file = params.get("f");
			if (!file) return fallback;
			const line = Number(params.get("l"));
			const base: FileRoute = { view: "file", file, side };
			return withOptional(base, "line", Number.isInteger(line) && line > 0 ? line : undefined);
		}
		case "changes": {
			const base: ChangesRoute = {
				view: "changes",
				section: sectionParam(params.get("sec")),
				tab: tabParam(params.get("tab")),
			};
			return withOptional(
				withOptional(base, "group", params.get("g") ?? undefined),
				"symbol",
				symbol,
			);
		}
		default:
			return fallback;
	}
}

function setParam(params: URLSearchParams, key: string, value: string | number | undefined) {
	if (value !== undefined && value !== "") params.set(key, String(value));
}

function setFlag(params: URLSearchParams, key: string, value: boolean) {
	if (value) params.set(key, "1");
}

function setSide(params: URLSearchParams, side: GraphSide) {
	if (side === "base") params.set("side", "base");
}

function routeParams(route: Route) {
	const params = new URLSearchParams();
	switch (route.view) {
		case "map":
			setParam(params, "p", route.path);
			setParam(params, "f", route.file);
			setFlag(params, "tests", route.tests);
			break;
		case "trace":
			setParam(params, "s", route.symbol);
			setSide(params, route.side);
			setParam(params, "x", route.expanded.join("\n"));
			setParam(params, "r", route.revealed.join("\n"));
			setFlag(params, "types", route.types);
			setFlag(params, "tests", route.tests);
			break;
		case "flow":
			setParam(params, "s", route.symbol);
			setSide(params, route.side);
			if (route.depth !== DEFAULT_FLOW_DEPTH) params.set("d", String(route.depth));
			if (route.layout === "sequence") params.set("layout", "sequence");
			setParam(params, "sel", route.selected);
			setFlag(params, "utils", route.utilities);
			break;
		case "symbol":
			setParam(params, "s", route.symbol);
			setSide(params, route.side);
			break;
		case "file":
			setParam(params, "f", route.file);
			setSide(params, route.side);
			setParam(params, "l", route.line);
			break;
		case "changes":
			if (route.section !== "groups") params.set("sec", route.section);
			setParam(params, "g", route.group);
			if (route.tab !== "calls") params.set("tab", route.tab);
			setParam(params, "s", route.symbol);
			break;
	}
	return params;
}

export function formatHash(route: Route) {
	const query = routeParams(route).toString();
	return query ? `#/${route.view}?${query}` : `#/${route.view}`;
}

export function mapHref(input: {
	path?: string | undefined;
	file?: string | undefined;
	tests?: boolean;
}) {
	const route: MapRoute = { view: "map", tests: input.tests ?? false };
	return formatHash(withOptional(withOptional(route, "path", input.path), "file", input.file));
}

export function symbolHref(symbol: SymbolId, side: GraphSide = "head") {
	return formatHash({ view: "symbol", symbol, side });
}

export function traceHref(symbol: SymbolId | undefined, side: GraphSide = "head") {
	const base: TraceRoute = {
		view: "trace",
		side,
		expanded: [],
		revealed: [],
		types: false,
		tests: false,
	};
	return formatHash(withOptional(base, "symbol", symbol));
}

export function flowHref(symbol: SymbolId | undefined, side: GraphSide = "head") {
	const base: FlowRoute = {
		view: "flow",
		layout: "waterfall",
		side,
		depth: DEFAULT_FLOW_DEPTH,
		utilities: false,
	};
	return formatHash(withOptional(base, "symbol", symbol));
}

export const CHANGES_HREF = formatHash({ view: "changes", section: "groups", tab: "calls" });
export const MAP_HREF = formatHash({ view: "map", tests: false });

export function fileHref(input: { file: string; side?: GraphSide; line?: number }) {
	const base: FileRoute = { view: "file", file: input.file, side: input.side ?? "head" };
	return formatHash(withOptional(base, "line", input.line));
}
