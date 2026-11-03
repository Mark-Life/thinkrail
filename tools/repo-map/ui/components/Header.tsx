import type { GraphRef, SymbolId } from "../../core/types";
import { plural, shortSha } from "../lib/format";
import { useHistoryPosition } from "../lib/hooks";
import { CHANGES_HREF, flowHref, MAP_HREF, type Route, traceHref } from "../lib/route";
import { sideOfSymbol, useWorkspace } from "../lib/workspace";
import { Icon } from "./Icons";

function refLabel(ref: GraphRef) {
	if (ref.kind === "commit") return shortSha(ref.sha);
	const dirty = ref.dirtyFiles.length;
	return dirty > 0
		? `working tree, ${plural(dirty, "changed file")}`
		: `working tree at ${shortSha(ref.sha)}`;
}

function activeView(route: Route) {
	return route.view === "symbol" || route.view === "file" ? undefined : route.view;
}

export function Header(props: {
	route: Route;
	lastSymbol: SymbolId | undefined;
	explorerOpen: boolean | undefined;
	onToggleExplorer: () => void;
	onOpenPalette: () => void;
}) {
	const workspace = useWorkspace();
	const { canGoBack, canGoForward } = useHistoryPosition();
	const { session, diff } = workspace;
	const active = activeView(props.route);
	const side = sideOfSymbol(workspace, props.lastSymbol);
	const tabs = [
		...(diff ? [{ id: "changes", label: "Changes", hint: "c", href: CHANGES_HREF }] : []),
		{ id: "map", label: "Map", hint: "m", href: MAP_HREF },
		{ id: "trace", label: "Trace", hint: "t", href: traceHref(props.lastSymbol, side) },
		{ id: "flow", label: "Flow", hint: "f", href: flowHref(props.lastSymbol, side) },
	];
	return (
		<header className="header">
			<div className="header-brand">
				<span className="brand-mark">repo-map</span>
				<span className="brand-repo">{session.repoName}</span>
				{session.mode === "diff" ? (
					<span className="ref-chip" title={session.title}>
						{refLabel(session.base)} .. {refLabel(session.head)}
					</span>
				) : (
					<span className="ref-chip">{refLabel(session.head)}</span>
				)}
			</div>
			<div className="header-history">
				<button
					type="button"
					className="icon-button"
					aria-label="Back"
					title="Back (press [)"
					disabled={!canGoBack}
					onClick={() => window.history.back()}
				>
					<Icon name="back" />
				</button>
				<button
					type="button"
					className="icon-button"
					aria-label="Forward"
					title="Forward (press ])"
					disabled={!canGoForward}
					onClick={() => window.history.forward()}
				>
					<Icon name="forward" />
				</button>
				{props.explorerOpen === undefined ? null : (
					<button
						type="button"
						className="icon-button"
						aria-label="Files and recent"
						aria-pressed={props.explorerOpen}
						title="Show or hide files and recent (press e)"
						onClick={props.onToggleExplorer}
					>
						<Icon name="panel" />
					</button>
				)}
			</div>
			<nav className="header-nav" aria-label="Views">
				{tabs.map((tab) => (
					<a
						key={tab.id}
						href={tab.href}
						className={active === tab.id ? "nav-tab nav-tab-active" : "nav-tab"}
						aria-current={active === tab.id ? "page" : undefined}
						title={`${tab.label} (press ${tab.hint})`}
					>
						{tab.label}
						<kbd className="nav-hint">{tab.hint}</kbd>
					</a>
				))}
			</nav>
			<button type="button" className="search-button" onClick={props.onOpenPalette}>
				<Icon name="search" />
				<span>Search symbols, files, modules</span>
				<kbd className="search-kbd">Cmd K</kbd>
			</button>
		</header>
	);
}
