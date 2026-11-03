import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphSide, SymbolId } from "../../core/types";
import {
	buildFileTree,
	type ExplorerRow,
	flattenExplorer,
	pushRecent,
	revealKeys,
} from "../lib/explorer";
import { displayName, kindLabel, kindName } from "../lib/format";
import { useVirtualRows } from "../lib/hooks";
import { type Route, symbolInViewHref } from "../lib/route";
import { useGraph } from "../lib/workspace";
import { Icon } from "./Icons";

const ROW_HEIGHT = 24;
const INDENT = 12;

function routeSide(route: Route): GraphSide {
	return "side" in route ? route.side : "head";
}

function activeSymbolOf(route: Route) {
	if (route.view === "flow") return route.selected ?? route.symbol;
	if (route.view === "trace" || route.view === "symbol") return route.symbol;
	return undefined;
}

function Row(props: {
	row: ExplorerRow;
	route: Route;
	side: GraphSide;
	active: SymbolId | undefined;
	activeFile: string | undefined;
	onToggle: (key: string) => void;
}) {
	const { row, route, side, active, activeFile, onToggle } = props;
	const paddingLeft = row.depth * INDENT + 8;
	if (row.kind === "symbol") {
		const current = row.symbol.id === active;
		return (
			<a
				className={current ? "explorer-row explorer-row-active" : "explorer-row"}
				style={{ paddingLeft: paddingLeft + 18 }}
				href={symbolInViewHref(route, row.symbol.id, side)}
				aria-current={current ? "true" : undefined}
				title={`${kindName(row.symbol.kind)} at line ${row.symbol.startLine}`}
			>
				<span className="explorer-kind">{kindLabel(row.symbol.kind)}</span>
				<span className="explorer-name explorer-symbol">{displayName(row.symbol)}</span>
			</a>
		);
	}
	const isCurrentFile = row.kind === "file" && row.key === activeFile;
	return (
		<button
			type="button"
			className={`explorer-row${isCurrentFile ? " explorer-row-current-file" : ""}`}
			style={{ paddingLeft }}
			aria-expanded={row.open}
			title={row.key}
			onClick={() => onToggle(row.key)}
		>
			<span className={row.open ? "explorer-chevron" : "explorer-chevron explorer-chevron-closed"}>
				<Icon name="chevronDown" />
			</span>
			<span className={row.kind === "dir" ? "explorer-name explorer-dir" : "explorer-name"}>
				{row.name}
			</span>
			{row.kind === "file" && row.symbols > 0 ? (
				<span className="explorer-count">{row.symbols}</span>
			) : null}
		</button>
	);
}

function FileTree(props: { route: Route; side: GraphSide; active: SymbolId | undefined }) {
	const { route, side, active } = props;
	const graph = useGraph(side);
	const [filter, setFilter] = useState("");
	const [tests, setTests] = useState(false);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const containerRef = useRef<HTMLDivElement>(null);
	const revealed = useRef<string | undefined>(undefined);
	const activeSymbol = active ? graph.symbols.get(active) : undefined;
	const activeFile = route.view === "file" ? route.file : activeSymbol?.file;
	const tree = useMemo(
		() => buildFileTree(graph.graph.files.filter((file) => tests || !file.isTest)),
		[graph, tests],
	);
	const rows = useMemo(
		() => flattenExplorer({ tree, expanded, fileSymbols: graph.fileSymbols, filter }),
		[tree, expanded, graph, filter],
	);
	const { start, end } = useVirtualRows({
		containerRef,
		count: rows.length,
		rowHeight: ROW_HEIGHT,
	});

	useEffect(() => {
		if (!activeFile) return;
		setExpanded((current) => {
			const keys = revealKeys(tree, activeFile);
			return keys.every((key) => current.has(key)) ? current : new Set([...current, ...keys]);
		});
	}, [activeFile, tree]);

	const revealTarget = active ?? activeFile;
	useEffect(() => {
		const element = containerRef.current;
		if (!element || !revealTarget || revealed.current === revealTarget) return;
		const index = rows.findIndex((row) => row.key === revealTarget);
		if (index < 0) return;
		revealed.current = revealTarget;
		const top = index * ROW_HEIGHT;
		if (top < element.scrollTop || top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
			element.scrollTop = Math.max(0, top - element.clientHeight / 3);
		}
	}, [revealTarget, rows]);

	const toggle = (key: string) => {
		const next = new Set(expanded);
		if (!next.delete(key)) next.add(key);
		setExpanded(next);
	};

	return (
		<>
			<div className="explorer-filter">
				<input
					className="explorer-input"
					type="search"
					placeholder="Filter files and symbols"
					aria-label="Filter files and symbols"
					value={filter}
					onChange={(event) => setFilter(event.target.value)}
				/>
				<label className="toggle" title="Show test files in the tree">
					<input
						type="checkbox"
						checked={tests}
						onChange={(event) => setTests(event.target.checked)}
					/>
					Tests
				</label>
			</div>
			<div className="explorer-scroll" ref={containerRef}>
				{rows.length === 0 ? (
					<p className="explorer-empty">Nothing matches this filter.</p>
				) : (
					<div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
						{rows.slice(start, end).map((row, offset) => (
							<div
								key={row.key}
								className="explorer-slot"
								style={{ top: (start + offset) * ROW_HEIGHT, height: ROW_HEIGHT }}
							>
								<Row
									row={row}
									route={route}
									side={side}
									active={active}
									activeFile={activeFile}
									onToggle={toggle}
								/>
							</div>
						))}
					</div>
				)}
			</div>
		</>
	);
}

function RecentList(props: {
	route: Route;
	side: GraphSide;
	active: SymbolId | undefined;
	recent: readonly SymbolId[];
}) {
	const { route, side, active, recent } = props;
	const graph = useGraph(side);
	const symbols = recent.flatMap((id) => graph.symbols.get(id) ?? []);
	if (symbols.length === 0) {
		return <p className="explorer-empty">Symbols you open appear here.</p>;
	}
	return (
		<div className="explorer-scroll">
			{symbols.map((symbol) => (
				<a
					key={symbol.id}
					className={
						symbol.id === active
							? "explorer-row explorer-row-tall explorer-row-active"
							: "explorer-row explorer-row-tall"
					}
					href={symbolInViewHref(route, symbol.id, side)}
					aria-current={symbol.id === active ? "true" : undefined}
					title={symbol.file}
				>
					<span className="explorer-kind">{kindLabel(symbol.kind)}</span>
					<span className="explorer-recent">
						<span className="explorer-name explorer-symbol">{displayName(symbol)}</span>
						<span className="explorer-path">{symbol.file}</span>
					</span>
				</a>
			))}
		</div>
	);
}

export function Explorer(props: { route: Route }) {
	const { route } = props;
	const [tab, setTab] = useState<"files" | "recent">("files");
	const [recent, setRecent] = useState<readonly SymbolId[]>([]);
	const side = routeSide(route);
	const active = activeSymbolOf(route);
	useEffect(() => {
		if (active) setRecent((current) => pushRecent(current, active));
	}, [active]);
	const tabs = [
		{ id: "files", label: "Files" },
		{ id: "recent", label: "Recent" },
	] as const;
	return (
		<aside className="explorer" aria-label="Explorer">
			<div className="explorer-tabs" role="tablist">
				{tabs.map((entry) => (
					<button
						key={entry.id}
						type="button"
						role="tab"
						aria-selected={tab === entry.id}
						className={tab === entry.id ? "tab tab-active" : "tab"}
						onClick={() => setTab(entry.id)}
					>
						{entry.label}
					</button>
				))}
			</div>
			<div className="explorer-panel" hidden={tab !== "files"}>
				<FileTree route={route} side={side} active={active} />
			</div>
			<div className="explorer-panel" hidden={tab !== "recent"}>
				<RecentList route={route} side={side} active={active} recent={recent} />
			</div>
		</aside>
	);
}
