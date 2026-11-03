import { useMemo } from "react";
import type { ChangeGroup, SymbolId } from "../../../core/types";
import { GraphCanvas } from "../../components/GraphCanvas";
import { type DrawnEdge, GraphEdges } from "../../components/GraphEdges";
import { GraphNodeBody } from "../../components/GraphNode";
import { buildGroupGraph, type DiffEdge, type DiffNode, STATUS_MARKS } from "../../lib/changes";
import { displayName, plural } from "../../lib/format";
import { layoutGraph } from "../../lib/layout";
import { type ChangesRoute, flowHref, formatHash, symbolHref, traceHref } from "../../lib/route";
import { useWorkspace } from "../../lib/workspace";

function edgeClass(edge: DiffEdge) {
	if (edge.status === "added") return "edge edge-added";
	if (edge.status === "removed") return "edge edge-removed";
	return edge.label ? "edge edge-wire" : "edge edge-same";
}

function Legend() {
	return (
		<div className="diff-legend">
			<span>
				<span className="status-mark status-added">+</span> added
			</span>
			<span>
				<span className="status-mark status-removed">-</span> removed
			</span>
			<span>
				<span className="status-mark status-modified">~</span> modified
			</span>
			<span>
				<span className="status-mark status-moved">&gt;</span> moved
			</span>
			<span className="legend-edge legend-edge-added">new call</span>
			<span className="legend-edge legend-edge-removed">removed call</span>
			<span className="legend-edge legend-edge-same">unchanged</span>
		</div>
	);
}

function markOffset(shape: "forward" | "back" | "same") {
	return shape === "forward" ? -32 : 16;
}

function nodeClass(node: DiffNode, focused: boolean) {
	return `node diff-node diff-${node.status}${focused ? " node-center" : ""}`;
}

export function GroupGraphTab(props: {
	group: ChangeGroup;
	focus: SymbolId | undefined;
	route: ChangesRoute;
}) {
	const { group, focus, route } = props;
	const { diff, head, base } = useWorkspace();
	const graph = useMemo(
		() =>
			diff && base ? buildGroupGraph({ group, diffIndex: diff, head, base, focus }) : undefined,
		[group, diff, head, base, focus],
	);
	const layout = useMemo(
		() =>
			graph
				? layoutGraph({ nodes: graph.nodes, edges: graph.edges, metrics: { padding: 32 } })
				: undefined,
		[graph],
	);
	const drawn = useMemo(
		() =>
			(layout?.edges ?? []).map(
				({ edge, path }): DrawnEdge => ({
					key: `${edge.from}|${edge.to}`,
					path,
					className: edgeClass(edge),
					title: `${edge.status} ${edge.kind}${edge.label ? `: ${edge.label}` : ""}`,
				}),
			),
		[layout],
	);
	if (!graph || !layout) return null;
	const selected = graph.nodes.find((node) => node.id === focus);
	return (
		<div className="group-graph">
			<div className="group-graph-bar">
				<Legend />
				{selected ? (
					<div className="group-selected">
						<span className="group-selected-name" title={selected.symbol.id}>
							{displayName(selected.symbol)}
						</span>
						<a className="muted-link" href={symbolHref(selected.symbol.id, selected.side)}>
							Details and source
						</a>
						<a className="muted-link" href={traceHref(selected.symbol.id, selected.side)}>
							Trace
						</a>
						<a className="muted-link" href={flowHref(selected.symbol.id, selected.side)}>
							Flow
						</a>
					</div>
				) : null}
				{graph.focused ? (
					<span className="notice-inline">
						Showing {graph.shownChanged} of {plural(graph.totalChanged, "changed symbol")} around
						the selected one. Pick another from the list.
					</span>
				) : null}
			</div>
			<GraphCanvas
				label={`Changes in ${group.title}`}
				content={{ width: layout.width, height: layout.height }}
				fitKey={`${group.id}|${graph.focused ? focus : ""}`}
			>
				<GraphEdges width={layout.width} height={layout.height} edges={drawn} />
				{layout.edges.flatMap(({ edge, endX, endY, shape }) =>
					edge.status === "same"
						? []
						: [
								<span
									key={`${edge.from}|${edge.to}`}
									className={`edge-mark status-${edge.status}`}
									style={{ transform: `translate(${endX + markOffset(shape)}px, ${endY - 8}px)` }}
									title={`${edge.status} ${edge.kind}`}
								>
									{edge.status === "added" ? "+" : "-"}
								</span>,
							],
				)}
				{layout.labels.map((label) => (
					<div
						key={`${label.x}:${label.y}:${label.text}`}
						className={`wire-pill-slot wire-pill-slot-${label.align}`}
						style={{ transform: `translate(${label.x}px, ${label.y}px)`, width: label.width }}
					>
						<span className="wire-pill" title={label.text}>
							<span className="wire-pill-kind">wire</span>
							<span className="wire-pill-text">{label.text}</span>
						</span>
					</div>
				))}
				{layout.nodes.map(({ node, x, y }) => (
					<div
						key={node.id}
						className={nodeClass(node, node.id === focus)}
						style={{
							transform: `translate(${x}px, ${y}px)`,
							width: node.width,
							height: node.height,
						}}
					>
						<GraphNodeBody
							symbol={node.symbol}
							href={formatHash({ ...route, group: group.id, symbol: node.symbol.id })}
							mark={node.status === "neighbor" ? undefined : STATUS_MARKS[node.status]}
							markClass={node.status === "neighbor" ? undefined : `status-${node.status}`}
						/>
					</div>
				))}
			</GraphCanvas>
		</div>
	);
}
