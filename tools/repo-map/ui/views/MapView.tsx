import { useMemo, useState } from "react";
import { InlineMessage } from "../components/States";
import { SymbolList } from "../components/SymbolList";
import { baseName, formatCount, formatLines, plural, shortModule } from "../lib/format";
import type { GraphIndex } from "../lib/graphIndex";
import { useElementSize } from "../lib/hooks";
import { fileHref, formatHash, type MapRoute, mapHref } from "../lib/route";
import {
	breadcrumb,
	buildMapTree,
	findNode,
	heatLegend,
	heatOf,
	heatStep,
	type MapNode,
	squarify,
} from "../lib/treemap";
import { useWorkspace } from "../lib/workspace";

const HEADER_HEIGHT = 20;
const TILE_INSET = 1;
const MIN_LABEL_WIDTH = 36;
const MIN_LABEL_HEIGHT = 16;
const MIN_NESTED_WIDTH = 60;
const MIN_NESTED_HEIGHT = 44;
const CONTENTS_CAP = 12;
const TOP_SYMBOLS = 12;

function hrefFor(node: MapNode, route: MapRoute, parent: MapNode) {
	if (node.kind === "file")
		return mapHref({ path: parent.path || undefined, file: node.path, tests: route.tests });
	return mapHref({ path: node.path, tests: route.tests });
}

function describe(node: MapNode) {
	const commits = heatOf(node).toFixed(node.kind === "file" ? 0 : 1);
	const kind = node.kind === "file" ? "commits in 90 days" : "commits per file, weighted by lines";
	return `${node.path || node.label}: ${formatCount(node.lines)} lines, ${commits} ${kind}`;
}

function Treemap(props: {
	node: MapNode;
	route: MapRoute;
	onHover: (node: MapNode | undefined) => void;
}) {
	const { node, route, onHover } = props;
	const { ref, size } = useElementSize<HTMLDivElement>();
	const tiles = useMemo(
		() =>
			squarify({
				items: node.children,
				value: (child) => child.lines,
				rect: { x: 0, y: 0, width: size.width, height: size.height },
			}),
		[node, size],
	);
	return (
		<div className="treemap" ref={ref}>
			{tiles.map((tile) => {
				const child = tile.item;
				const nested =
					child.children.length > 0 &&
					tile.width >= MIN_NESTED_WIDTH &&
					tile.height >= MIN_NESTED_HEIGHT;
				return nested ? (
					<NestedTile key={child.path} node={child} route={route} box={tile} onHover={onHover} />
				) : (
					<LeafTile
						key={child.path}
						node={child}
						parent={node}
						route={route}
						box={tile}
						onHover={onHover}
					/>
				);
			})}
		</div>
	);
}

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

function boxStyle(box: Box) {
	return {
		left: box.x + TILE_INSET,
		top: box.y + TILE_INSET,
		width: Math.max(0, box.width - TILE_INSET * 2),
		height: Math.max(0, box.height - TILE_INSET * 2),
	};
}

function LeafTile(props: {
	node: MapNode;
	parent: MapNode;
	route: MapRoute;
	box: Box;
	onHover: (node: MapNode | undefined) => void;
}) {
	const { node, parent, route, box, onHover } = props;
	const step = heatStep(heatOf(node));
	const selected = route.file === node.path;
	const labeled = box.width >= MIN_LABEL_WIDTH && box.height >= MIN_LABEL_HEIGHT;
	return (
		<a
			className={`tile tile-leaf heat-${step}${selected ? " tile-selected" : ""}`}
			href={hrefFor(node, route, parent)}
			style={boxStyle(box)}
			title={describe(node)}
			aria-label={describe(node)}
			onMouseEnter={() => onHover(node)}
			onMouseLeave={() => onHover(undefined)}
			onFocus={() => onHover(node)}
		>
			{labeled ? <span className="tile-label">{node.label}</span> : null}
			{labeled && box.height >= 36 ? (
				<span className="tile-size">{formatLines(node.lines)}</span>
			) : null}
		</a>
	);
}

function NestedTile(props: {
	node: MapNode;
	route: MapRoute;
	box: Box;
	onHover: (node: MapNode | undefined) => void;
}) {
	const { node, route, box, onHover } = props;
	const style = boxStyle(box);
	const inner = squarify({
		items: node.children,
		value: (child) => child.lines,
		rect: { x: 0, y: 0, width: style.width, height: style.height - HEADER_HEIGHT },
	});
	return (
		<div className="tile tile-group" style={style}>
			<a
				className="tile-header"
				href={mapHref({ path: node.path, tests: route.tests })}
				title={describe(node)}
				onMouseEnter={() => onHover(node)}
				onMouseLeave={() => onHover(undefined)}
				onFocus={() => onHover(node)}
			>
				<span className="tile-label">{node.label}</span>
				<span className="tile-size">{formatLines(node.lines)}</span>
			</a>
			<div className="tile-inner">
				{inner.map((tile) => (
					<LeafTile
						key={tile.item.path}
						node={tile.item}
						parent={node}
						route={route}
						box={tile}
						onHover={onHover}
					/>
				))}
			</div>
		</div>
	);
}

function HeatLegend() {
	return (
		<div className="heat-legend" role="img" aria-label="Color shows commits in the last 90 days">
			<span className="heat-legend-title">Commits, 90 days</span>
			{heatLegend().map((entry) => (
				<span key={entry.step} className="heat-legend-entry">
					<span className={`heat-swatch heat-${entry.step}`} />
					{entry.label}
				</span>
			))}
		</div>
	);
}

function ModuleLinks(props: {
	title: string;
	edges: { module: string; imports: number }[];
	route: MapRoute;
}) {
	return (
		<section>
			<h3 className="section-title">
				{props.title} <span className="section-count">{props.edges.length}</span>
			</h3>
			{props.edges.length === 0 ? (
				<p className="list-empty">None.</p>
			) : (
				<ul className="module-links">
					{props.edges.slice(0, CONTENTS_CAP).map((edge) => (
						<li key={edge.module}>
							<a
								className="module-link"
								href={mapHref({ path: edge.module, tests: props.route.tests })}
							>
								<span className="module-link-name">{shortModule(edge.module)}</span>
								<span className="module-link-count" title={plural(edge.imports, "import")}>
									{formatCount(edge.imports)}
								</span>
							</a>
						</li>
					))}
					{props.edges.length > CONTENTS_CAP ? (
						<li className="list-more">and {props.edges.length - CONTENTS_CAP} more</li>
					) : null}
				</ul>
			)}
		</section>
	);
}

function topSymbols(index: GraphIndex, modulePath: string) {
	const inScope = [...index.moduleSymbols.entries()]
		.filter(([path]) => path === modulePath || path.startsWith(`${modulePath}/`))
		.flatMap(([, symbols]) => symbols);
	return inScope
		.filter((symbol) => !symbol.isTest && symbol.kind !== "module")
		.map((symbol) => ({ symbol, uses: (index.incoming.get(symbol.id) ?? []).length }))
		.sort(
			(left, right) => right.uses - left.uses || left.symbol.name.localeCompare(right.symbol.name),
		)
		.slice(0, TOP_SYMBOLS)
		.map((entry) => entry.symbol);
}

function ModulePanel(props: { node: MapNode; route: MapRoute }) {
	const { node, route } = props;
	const { head } = useWorkspace();
	const info = head.modules.get(node.path);
	const outgoing = (head.moduleOut.get(node.path) ?? []).map((edge) => ({
		module: edge.to,
		imports: edge.imports,
	}));
	const incoming = (head.moduleIn.get(node.path) ?? []).map((edge) => ({
		module: edge.from,
		imports: edge.imports,
	}));
	const top = useMemo(
		() => (node.kind === "module" ? topSymbols(head, node.path) : []),
		[head, node],
	);
	return (
		<>
			<div className="symbol-header">
				<h2 className="symbol-title">{info?.title ?? node.label}</h2>
				{node.path ? <div className="symbol-meta">{node.path}</div> : null}
				<div className="symbol-meta">
					<span>{formatCount(node.lines)} lines</span>
					<span>{plural(node.children.length, "item")}</span>
				</div>
				{info?.responsibility ? (
					<p className="panel-text">{info.responsibility}</p>
				) : node.kind === "module" ? (
					<p className="panel-note">This module has no SPEC.md.</p>
				) : (
					<p className="panel-text">
						Tile area shows lines of code. Color shows recent commits. Click a tile to go deeper.
					</p>
				)}
			</div>
			<div className="symbol-sections">
				{node.kind === "module" ? (
					<>
						<ModuleLinks title="Depends on" edges={outgoing} route={route} />
						<ModuleLinks title="Used by" edges={incoming} route={route} />
						{top.length > 0 ? (
							<section>
								<h3 className="section-title">Most used symbols</h3>
								<SymbolList symbols={top} emptyText="" />
							</section>
						) : null}
					</>
				) : null}
				<section>
					<h3 className="section-title">
						Contents <span className="section-count">{node.children.length}</span>
					</h3>
					<table className="contents-table">
						<thead>
							<tr>
								<th scope="col">Name</th>
								<th scope="col" className="numeric">
									Lines
								</th>
								<th scope="col" className="numeric">
									Commits
								</th>
							</tr>
						</thead>
						<tbody>
							{node.children.slice(0, CONTENTS_CAP).map((child) => (
								<tr key={child.path}>
									<td className="contents-name">
										<a href={hrefFor(child, route, node)} title={child.path}>
											{child.label}
										</a>
									</td>
									<td className="numeric">{formatLines(child.lines)}</td>
									<td className="numeric">
										{heatOf(child).toFixed(child.kind === "file" ? 0 : 1)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
					{node.children.length > CONTENTS_CAP ? (
						<p className="list-more">and {node.children.length - CONTENTS_CAP} more</p>
					) : null}
				</section>
			</div>
		</>
	);
}

function FilePanel(props: { path: string; route: MapRoute }) {
	const { path, route } = props;
	const { head } = useWorkspace();
	const info = head.files.get(path);
	if (!info) return <InlineMessage title="This file is not in the graph" />;
	const symbols = (head.fileSymbols.get(path) ?? []).filter((symbol) => symbol.kind !== "module");
	return (
		<>
			<div className="symbol-header">
				<h2 className="symbol-title">{baseName(path)}</h2>
				<div className="symbol-meta">
					<a className="muted-link" href={mapHref({ path: info.module, tests: route.tests })}>
						{shortModule(info.module)}
					</a>
					<span>{formatCount(info.lines)} lines</span>
					<span>{plural(info.commits90d, "commit")}, 90 days</span>
				</div>
				<div className="symbol-actions">
					<a className="button button-primary" href={fileHref({ file: path })}>
						Open source
					</a>
				</div>
			</div>
			<div className="symbol-sections">
				<section>
					<h3 className="section-title">
						Symbols <span className="section-count">{symbols.length}</span>
					</h3>
					<SymbolList symbols={symbols} emptyText="This file declares no symbols." />
				</section>
			</div>
		</>
	);
}

export function MapView(props: { route: MapRoute }) {
	const { route } = props;
	const { head } = useWorkspace();
	const [hovered, setHovered] = useState<MapNode | undefined>();
	const { root } = useMemo(
		() =>
			buildMapTree({
				files: head.graph.files,
				modules: head.graph.modules,
				includeTests: route.tests,
			}),
		[head, route.tests],
	);
	const node = findNode(root, route.path) ?? root;
	const trail = breadcrumb(root, node.path);
	return (
		<div className="map-view">
			<div className="map-main">
				<div className="map-toolbar">
					<nav className="breadcrumb" aria-label="Breadcrumb">
						{trail.map((entry, position) => (
							<span key={entry.path || "root"} className="breadcrumb-item">
								{position > 0 ? <span className="breadcrumb-sep">/</span> : null}
								{position === trail.length - 1 ? (
									<span aria-current="page">{entry.label}</span>
								) : (
									<a href={mapHref({ path: entry.path || undefined, tests: route.tests })}>
										{entry.label}
									</a>
								)}
							</span>
						))}
					</nav>
					<label className="toggle">
						<input
							type="checkbox"
							checked={route.tests}
							onChange={(event) => {
								window.location.hash = formatHash({ ...route, tests: event.target.checked });
							}}
						/>
						Show test files
					</label>
					<HeatLegend />
				</div>
				{node.children.length === 0 ? (
					<div className="view-center">
						<InlineMessage title="Nothing to show here">
							<p>All files in this module are tests. Turn on "Show test files".</p>
						</InlineMessage>
					</div>
				) : (
					<Treemap
						key={`${node.path}:${route.tests}`}
						node={node}
						route={route}
						onHover={setHovered}
					/>
				)}
				<div className="map-readout" aria-live="off">
					{hovered
						? describe(hovered)
						: `${node.path || "Repository"}: ${formatCount(node.lines)} lines`}
				</div>
			</div>
			<aside className="map-panel">
				{route.file ? (
					<FilePanel path={route.file} route={route} />
				) : (
					<ModulePanel node={node} route={route} />
				)}
			</aside>
		</div>
	);
}
