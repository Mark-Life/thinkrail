import { useEffect, useMemo, useRef, useState } from "react";
import type { CodeSymbol, SymbolId } from "../../core/types";
import { GraphCanvas, type GraphCanvasHandle } from "../components/GraphCanvas";
import { type DrawnEdge, GraphEdges } from "../components/GraphEdges";
import { GraphNodeBody } from "../components/GraphNode";
import { Icon } from "../components/Icons";
import { SplitWithSource } from "../components/SplitWithSource";
import { StartPicker } from "../components/StartPicker";
import { InlineMessage } from "../components/States";
import { STATUS_MARKS } from "../lib/changes";
import { displayName, shortModule } from "../lib/format";
import { isTypingTarget } from "../lib/hooks";
import { type GraphLayout, layoutGraph } from "../lib/layout";
import { nearestInDirection } from "../lib/navigation";
import { formatHash, symbolHref, type TraceRoute } from "../lib/route";
import {
	buildTrace,
	type TraceEdge,
	type TraceMoreNode,
	type TraceNode,
	type TraceSymbolNode,
} from "../lib/trace";
import { useGraph, useWorkspace } from "../lib/workspace";

const WIRE_EDGE_KINDS = new Set(["wire-request", "wire-push", "tool-render"]);
const KIND_SHORT: Record<string, string> = {
	"wire-request": "req",
	"wire-push": "push",
	"tool-render": "tool",
};
const BAND_KINDS: Record<string, string> = {
	"wire-request": "request",
	"wire-push": "push",
	"tool-render": "tool render",
};

type Layout = GraphLayout<TraceNode, TraceEdge>;

function edgeClass(edge: TraceEdge) {
	if (WIRE_EDGE_KINDS.has(edge.kind)) return `edge edge-wire edge-${edge.kind}`;
	if (edge.kind === "more") return "edge edge-more";
	return `edge edge-${edge.kind}`;
}

function drawEdges(layout: Layout) {
	return layout.edges.map(
		({ edge, path }): DrawnEdge => ({
			key: `${edge.from}|${edge.to}`,
			path,
			className: edgeClass(edge),
			title: edge.label ? `${edge.kind}: ${edge.label}` : edge.kind,
		}),
	);
}

function retarget(route: TraceRoute, symbol: SymbolId): TraceRoute {
	return { ...route, symbol, expanded: [], revealed: [] };
}

function pillHref(route: TraceRoute, edge: TraceEdge) {
	return formatHash(retarget(route, edge.to as SymbolId));
}

function toggled(list: readonly string[], value: string) {
	return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function SymbolNode(props: {
	node: TraceSymbolNode;
	x: number;
	y: number;
	route: TraceRoute;
	dim: boolean;
	onHover: (id: string | undefined) => void;
}) {
	const { node, route, x, y, dim, onHover } = props;
	const { packages, diff } = useWorkspace();
	const slot = packages.slotOf(node.symbol.module);
	const status =
		route.side === "head"
			? diff?.statusByHead.get(node.symbol.id)
			: diff?.statusByBase.get(node.symbol.id);
	const center = node.direction === "center";
	const canExpand = !center && node.hiddenNeighbors > 0;
	const canCollapse = !center && node.expanded;
	const side = node.direction === "caller" ? "left" : "right";
	const noun = node.direction === "caller" ? "callers" : "callees";
	return (
		<div
			className={`node ${slot === undefined ? "pkg-other" : `pkg-${slot}`}${center ? " node-center" : ""}${dim ? " node-dim" : ""}`}
			style={{ transform: `translate(${x}px, ${y}px)`, width: node.width, height: node.height }}
		>
			<GraphNodeBody
				symbol={node.symbol}
				href={formatHash(retarget(route, node.symbol.id))}
				mark={status ? STATUS_MARKS[status] : undefined}
				markClass={status ? `status-${status}` : undefined}
				centered={center}
				onHover={(hovering) => onHover(hovering ? node.id : undefined)}
			/>
			{canExpand ? (
				<a
					className={`node-handle node-handle-${side}`}
					href={formatHash({ ...route, expanded: toggled(route.expanded, node.id) })}
					title={`Show ${node.hiddenNeighbors} ${noun}`}
					aria-label={`Show ${node.hiddenNeighbors} ${noun} of ${node.symbol.name}`}
				>
					+{node.hiddenNeighbors}
				</a>
			) : null}
			{canCollapse ? (
				<a
					className={`node-handle node-handle-${side}`}
					href={formatHash({ ...route, expanded: toggled(route.expanded, node.id) })}
					title={`Hide ${noun}`}
					aria-label={`Hide ${noun} of ${node.symbol.name}`}
				>
					<Icon name="minus" />
				</a>
			) : null}
		</div>
	);
}

function MoreNode(props: {
	node: TraceMoreNode;
	x: number;
	y: number;
	route: TraceRoute;
	dim: boolean;
}) {
	const { node, route, x, y, dim } = props;
	const href = node.exhausted
		? symbolHref(node.owner, route.side)
		: formatHash({ ...route, revealed: [...route.revealed, node.revealKey] });
	return (
		<a
			className={`node-more${dim ? " node-dim" : ""}`}
			href={href}
			style={{ transform: `translate(${x}px, ${y}px)`, width: node.width, height: node.height }}
			title={node.exhausted ? "Open the full list" : "Show more"}
		>
			+{node.hidden} more
		</a>
	);
}

function WireBands(props: { layout: Layout }) {
	const { layout } = props;
	const positions = new Map(layout.nodes.map((entry) => [entry.node.id, entry.node.layer]));
	const symbolsById = new Map(
		layout.nodes.flatMap((entry) =>
			entry.node.type === "symbol" ? [[entry.node.id, entry.node.symbol] as const] : [],
		),
	);
	return (
		<>
			{layout.bands.map((band) => {
				const crossing = layout.edges.filter(({ edge }) => {
					if (!edge.wide) return false;
					const from = positions.get(edge.from) ?? 0;
					const to = positions.get(edge.to) ?? 0;
					return Math.min(from, to) === band.afterLayer;
				});
				const first = crossing[0]?.edge;
				const source: CodeSymbol | undefined = first ? symbolsById.get(first.from) : undefined;
				const target: CodeSymbol | undefined = first ? symbolsById.get(first.to) : undefined;
				const route =
					source && target
						? `${shortModule(source.module).split("/")[0]} to ${shortModule(target.module).split("/")[0]}`
						: "";
				const kinds = [
					...new Set(crossing.map(({ edge }) => BAND_KINDS[edge.kind] ?? edge.kind)),
				].join(", ");
				return (
					<div
						key={band.afterLayer}
						className="wire-band"
						style={{ left: band.x, width: band.width, height: layout.height }}
					>
						<div className="wire-band-title">Wire: {kinds}</div>
						<div className="wire-band-route">{route}</div>
					</div>
				);
			})}
		</>
	);
}

function PackageLegend(props: { layout: Layout }) {
	const { packages } = useWorkspace();
	const present = new Set(
		props.layout.nodes.flatMap((entry) =>
			entry.node.type === "symbol" ? [packages.slotOf(entry.node.symbol.module)] : [],
		),
	);
	return (
		<div className="pkg-legend">
			{packages.legend
				.filter((entry) => present.has(entry.slot))
				.map((entry) => (
					<span key={entry.name} className="pkg-legend-entry">
						<span className={`pkg-swatch pkg-${entry.slot}`} />
						{entry.name}
					</span>
				))}
			{present.has(undefined) ? (
				<span className="pkg-legend-entry">
					<span className="pkg-swatch pkg-other" />
					other
				</span>
			) : null}
		</div>
	);
}

function highlightedEdges(layout: Layout, hovered: string | undefined) {
	if (!hovered) return undefined;
	const keys = new Set<string>();
	const nodes = new Set<string>([hovered]);
	for (const { edge } of layout.edges) {
		if (edge.from === hovered || edge.to === hovered) {
			keys.add(`${edge.from}|${edge.to}`);
			nodes.add(edge.from);
			nodes.add(edge.to);
		}
	}
	return { keys, nodes };
}

export function TraceView(props: { route: TraceRoute }) {
	const { route } = props;
	const index = useGraph(route.side);
	const canvasRef = useRef<GraphCanvasHandle>(null);
	const surfaceRef = useRef<HTMLDivElement>(null);
	const [hovered, setHovered] = useState<string | undefined>();
	const { symbol: center } = route;
	const expanded = useMemo(() => new Set(route.expanded), [route.expanded]);
	const revealed = useMemo(() => new Set(route.revealed), [route.revealed]);
	const trace = useMemo(
		() =>
			center
				? buildTrace({ index, center, expanded, revealed, types: route.types, tests: route.tests })
				: undefined,
		[index, center, expanded, revealed, route.types, route.tests],
	);
	const layout = useMemo(
		() =>
			trace
				? layoutGraph({
						nodes: trace.nodes,
						edges: trace.edges,
						metrics: { padding: 56 },
					})
				: undefined,
		[trace],
	);
	useEffect(() => {
		if (layout) setHovered(undefined);
	}, [layout]);
	const anchor = useMemo(() => {
		const entry = layout?.nodes.find((item) => item.node.id === center);
		return entry
			? { x: entry.x + entry.node.width / 2, y: entry.y + entry.node.height / 2 }
			: undefined;
	}, [layout, center]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!layout || isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey)
				return;
			const direction =
				event.key === "ArrowLeft"
					? "left"
					: event.key === "ArrowRight"
						? "right"
						: event.key === "ArrowUp"
							? "up"
							: event.key === "ArrowDown"
								? "down"
								: undefined;
			if (!direction) return;
			const active = document.activeElement;
			const currentId = active instanceof HTMLElement ? active.dataset.nodeId : undefined;
			const nodes = layout.nodes.flatMap((entry) =>
				entry.node.type === "symbol"
					? [
							{
								id: entry.node.id,
								layer: entry.node.layer,
								x: entry.x,
								y: entry.y,
								width: entry.node.width,
								height: entry.node.height,
							},
						]
					: [],
			);
			const nextId = currentId ? nearestInDirection({ nodes, from: currentId, direction }) : center;
			if (!nextId) return;
			event.preventDefault();
			const element = surfaceRef.current?.querySelector<HTMLElement>(
				`[data-node-id="${CSS.escape(nextId)}"]`,
			);
			element?.focus({ preventScroll: true });
			const target = nodes.find((node) => node.id === nextId);
			if (target) canvasRef.current?.ensureVisible(target);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [layout, center]);

	if (!center) {
		return (
			<StartPicker
				title="Pick a symbol to trace"
				detail="Trace shows who calls a symbol on the left and what it calls on the right, including across the wire."
				hrefFor={(id) => formatHash(retarget(route, id))}
			/>
		);
	}
	const symbol = index.symbols.get(center);
	if (!symbol || !trace || !layout) {
		return (
			<div className="view-center">
				<InlineMessage title="This symbol is not in the graph">
					<p>
						<code>{center}</code> does not exist on the {route.side} side.
					</p>
				</InlineMessage>
			</div>
		);
	}
	const highlight = highlightedEdges(layout, hovered);
	const hasNeighbors = layout.nodes.length > 1;
	return (
		<SplitWithSource
			symbol={symbol}
			side={route.side}
			active="trace"
			linkFor={(target) => formatHash(retarget(route, target))}
		>
			{(sourceToggle) => (
				<>
					<div className="graph-toolbar">
						<span className="graph-title" title={center}>
							{displayName(symbol)}
						</span>
						<span className="graph-direction">callers on the left, callees on the right</span>
						<label className="toggle">
							<input
								type="checkbox"
								checked={route.types || trace.typesForced}
								disabled={trace.typesForced}
								onChange={(event) => {
									window.location.hash = formatHash({ ...route, types: event.target.checked });
								}}
							/>
							Type references{trace.hiddenTypeRefs > 0 ? ` (${trace.hiddenTypeRefs} hidden)` : ""}
						</label>
						<label className="toggle">
							<input
								type="checkbox"
								checked={route.tests}
								onChange={(event) => {
									window.location.hash = formatHash({ ...route, tests: event.target.checked });
								}}
							/>
							Tests{trace.hiddenTests > 0 ? ` (${trace.hiddenTests} hidden)` : ""}
						</label>
						<PackageLegend layout={layout} />
						{sourceToggle}
					</div>
					<div className="graph-surface" ref={surfaceRef}>
						<GraphCanvas
							ref={canvasRef}
							label={`Trace of ${symbol.name}`}
							content={{ width: layout.width, height: layout.height }}
							anchor={anchor}
							fitKey={`${center}|${route.side}|${route.types}|${route.tests}|${route.expanded.length}|${route.revealed.length}`}
						>
							<WireBands layout={layout} />
							<GraphEdges
								width={layout.width}
								height={layout.height}
								edges={drawEdges(layout)}
								highlighted={highlight?.keys}
							/>
							{layout.labels.map((label) => {
								const edge = label.edges[0];
								return (
									<div
										key={`${label.x}:${label.text}:${edge?.to ?? ""}`}
										className={`wire-pill-slot wire-pill-slot-${label.align}`}
										style={{
											transform: `translate(${label.x}px, ${label.y}px)`,
											width: label.width,
										}}
									>
										<a
											className={`wire-pill wire-pill-${edge?.kind ?? "call"}${label.text === "impl" ? " wire-pill-muted" : ""}`}
											href={edge ? pillHref(route, edge) : undefined}
											title={`${edge?.kind ?? ""}: ${label.text}`}
										>
											{edge && KIND_SHORT[edge.kind] ? (
												<span className="wire-pill-kind">{KIND_SHORT[edge.kind]}</span>
											) : null}
											<span className="wire-pill-text">{label.text}</span>
										</a>
									</div>
								);
							})}
							{layout.nodes.map((entry) => {
								const dim = highlight !== undefined && !highlight.nodes.has(entry.node.id);
								return entry.node.type === "symbol" ? (
									<SymbolNode
										key={entry.node.id}
										node={entry.node}
										x={entry.x}
										y={entry.y}
										route={route}
										dim={dim}
										onHover={setHovered}
									/>
								) : (
									<MoreNode
										key={entry.node.id}
										node={entry.node}
										x={entry.x}
										y={entry.y}
										route={route}
										dim={dim}
									/>
								);
							})}
						</GraphCanvas>
						{hasNeighbors ? null : (
							<div className="graph-empty">
								<InlineMessage title="No callers or callees found">
									<p>
										This symbol has no static links in the repo. Dynamic dispatch can be missing.
										Turn on type references or tests to widen the view.
									</p>
								</InlineMessage>
							</div>
						)}
					</div>
				</>
			)}
		</SplitWithSource>
	);
}
