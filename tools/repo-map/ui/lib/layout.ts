export interface LayoutNode {
	id: string;
	layer: number;
	width: number;
	height: number;
}

export interface LayoutEdge {
	from: string;
	to: string;
	label?: string;
	wide?: boolean;
}

interface LayoutMetrics {
	padding: number;
	sidePadding: number;
	nodeGap: number;
	layerGap: number;
	wideLayerGap: number;
	labelHeight: number;
}

interface PlacedNode<N> {
	node: N;
	x: number;
	y: number;
}

interface PlacedEdge<E> {
	edge: E;
	path: string;
	midX: number;
	midY: number;
	endX: number;
	endY: number;
	shape: "forward" | "back" | "same";
}

interface PlacedLabel<E> {
	text: string;
	x: number;
	y: number;
	width: number;
	align: "start" | "end";
	edges: E[];
}

interface WireBand {
	afterLayer: number;
	x: number;
	width: number;
}

export interface GraphLayout<N, E> {
	nodes: PlacedNode<N>[];
	edges: PlacedEdge<E>[];
	labels: PlacedLabel<E>[];
	bands: WireBand[];
	width: number;
	height: number;
}

const DEFAULT_METRICS: LayoutMetrics = {
	padding: 32,
	sidePadding: 24,
	nodeGap: 12,
	layerGap: 88,
	wideLayerGap: 256,
	labelHeight: 24,
};
const ORDER_SWEEPS = 8;
const POSITION_SWEEPS = 6;
const PORT_SPACING = 4;
const PORT_MARGIN = 8;
const LABEL_MARGIN = 12;

export function assignLayers(input: {
	ids: readonly string[];
	roots: readonly string[];
	edges: readonly Pick<LayoutEdge, "from" | "to">[];
}) {
	const outgoing = new Map<string, string[]>();
	for (const edge of input.edges) {
		const bucket = outgoing.get(edge.from);
		if (bucket) bucket.push(edge.to);
		else outgoing.set(edge.from, [edge.to]);
	}
	const layers = new Map<string, number>();
	const visit = (seeds: readonly string[]) => {
		const queue = [...seeds];
		for (const seed of seeds) layers.set(seed, layers.get(seed) ?? 0);
		for (let cursor = 0; cursor < queue.length; cursor++) {
			const id = queue[cursor];
			if (id === undefined) continue;
			const layer = layers.get(id) ?? 0;
			for (const next of outgoing.get(id) ?? []) {
				if (layers.has(next)) continue;
				layers.set(next, layer + 1);
				queue.push(next);
			}
		}
	};
	visit(input.roots);
	for (const id of input.ids) {
		if (!layers.has(id)) visit([id]);
	}
	return layers;
}

function groupByLayer<N extends LayoutNode>(nodes: readonly N[]) {
	const layers = new Map<number, N[]>();
	for (const node of nodes) {
		const bucket = layers.get(node.layer);
		if (bucket) bucket.push(node);
		else layers.set(node.layer, [node]);
	}
	return [...layers.entries()].sort((left, right) => left[0] - right[0]);
}

function neighborMap(edges: readonly LayoutEdge[]) {
	const neighbors = new Map<string, string[]>();
	const link = (from: string, to: string) => {
		const bucket = neighbors.get(from);
		if (bucket) bucket.push(to);
		else neighbors.set(from, [to]);
	};
	for (const edge of edges) {
		if (edge.from === edge.to) continue;
		link(edge.from, edge.to);
		link(edge.to, edge.from);
	}
	return neighbors;
}

type LayerOrder<N> = [number, N[]][];

export function countCrossings<N extends LayoutNode>(input: {
	layers: LayerOrder<N>;
	edges: readonly LayoutEdge[];
}) {
	const position = new Map<string, { layer: number; order: number }>();
	for (const [layer, nodes] of input.layers) {
		for (const [order, node] of nodes.entries()) position.set(node.id, { layer, order });
	}
	const segments = input.edges.flatMap((edge) => {
		const from = position.get(edge.from);
		const to = position.get(edge.to);
		if (!from || !to || from.layer === to.layer) return [];
		const [left, right] = from.layer < to.layer ? [from, to] : [to, from];
		return [{ layer: left.layer, a: left.order, b: right.order }];
	});
	let crossings = 0;
	for (const [index, first] of segments.entries()) {
		for (const second of segments.slice(index + 1)) {
			if (first.layer !== second.layer) continue;
			if ((first.a - second.a) * (first.b - second.b) < 0) crossings += 1;
		}
	}
	return crossings;
}

function sortByBarycenter<N extends LayoutNode>(input: {
	nodes: readonly N[];
	neighbors: ReadonlyMap<string, string[]>;
	order: ReadonlyMap<string, number>;
	isReference: (id: string) => boolean;
}) {
	const { nodes, neighbors, order, isReference } = input;
	const weights = new Map<string, number>();
	nodes.forEach((node, current) => {
		const references = (neighbors.get(node.id) ?? []).filter(isReference);
		const sum = references.reduce((total, id) => total + (order.get(id) ?? 0), 0);
		weights.set(node.id, references.length > 0 ? sum / references.length : current);
	});
	return [...nodes].sort(
		(left, right) => (weights.get(left.id) ?? 0) - (weights.get(right.id) ?? 0),
	);
}

export function orderLayers<N extends LayoutNode>(input: {
	nodes: readonly N[];
	edges: readonly LayoutEdge[];
}) {
	const neighbors = neighborMap(input.edges);
	const layerOf = new Map(input.nodes.map((node) => [node.id, node.layer]));
	let layers: LayerOrder<N> = groupByLayer(input.nodes);
	let best = layers;
	let bestCrossings = countCrossings({ layers, edges: input.edges });
	for (let sweep = 0; sweep < ORDER_SWEEPS && bestCrossings > 0; sweep++) {
		const forward = sweep % 2 === 0;
		const sequence = forward ? layers : [...layers].reverse();
		const order = new Map<string, number>();
		for (const [, nodes] of layers) {
			for (const [position, node] of nodes.entries()) order.set(node.id, position);
		}
		const next = new Map<number, N[]>();
		for (const [layer, nodes] of sequence) {
			const sorted = sortByBarycenter({
				nodes,
				neighbors,
				order,
				isReference: (id) => {
					const other = layerOf.get(id);
					if (other === undefined) return false;
					return forward ? other < layer : other > layer;
				},
			});
			for (const [position, node] of sorted.entries()) order.set(node.id, position);
			next.set(layer, sorted);
		}
		layers = layers.map(([layer, nodes]) => [layer, next.get(layer) ?? nodes]);
		const crossings = countCrossings({ layers, edges: input.edges });
		if (crossings < bestCrossings) {
			best = layers;
			bestCrossings = crossings;
		}
	}
	return best;
}

export function resolveOverlaps(input: {
	desired: readonly number[];
	sizes: readonly number[];
	gap: number;
}) {
	const { desired, sizes, gap } = input;
	const offsets: number[] = [];
	let offset = 0;
	sizes.forEach((size, index) => {
		if (index > 0) offset += ((sizes[index - 1] ?? 0) + size) / 2 + gap;
		offsets.push(offset);
	});
	const blocks: { mean: number; count: number }[] = [];
	desired.forEach((value, index) => {
		let block = { mean: value - (offsets[index] ?? 0), count: 1 };
		for (let top = blocks.at(-1); top && top.mean >= block.mean; top = blocks.at(-1)) {
			const count = top.count + block.count;
			block = { mean: (top.mean * top.count + block.mean * block.count) / count, count };
			blocks.pop();
		}
		blocks.push(block);
	});
	const centers: number[] = [];
	for (const block of blocks) {
		for (let step = 0; step < block.count; step++) {
			centers.push(block.mean + (offsets[centers.length] ?? 0));
		}
	}
	return centers;
}

function positionNodes<N extends LayoutNode>(input: {
	layers: LayerOrder<N>;
	edges: readonly LayoutEdge[];
	nodeGap: number;
}) {
	const { layers, edges, nodeGap } = input;
	const neighbors = neighborMap(edges);
	const centers = new Map<string, number>();
	for (const [, nodes] of layers) {
		const placed = resolveOverlaps({
			desired: nodes.map(() => 0),
			sizes: nodes.map((node) => node.height),
			gap: nodeGap,
		});
		nodes.forEach((node, index) => {
			centers.set(node.id, placed[index] ?? 0);
		});
	}
	const relax = (sequence: LayerOrder<N>) => {
		for (const [, nodes] of sequence) {
			const desired = nodes.map((node) => {
				const others = (neighbors.get(node.id) ?? []).filter((id) => centers.has(id));
				if (others.length === 0) return centers.get(node.id) ?? 0;
				return others.reduce((sum, id) => sum + (centers.get(id) ?? 0), 0) / others.length;
			});
			const placed = resolveOverlaps({
				desired,
				sizes: nodes.map((node) => node.height),
				gap: nodeGap,
			});
			nodes.forEach((node, index) => {
				centers.set(node.id, placed[index] ?? 0);
			});
		}
	};
	for (let sweep = 0; sweep < POSITION_SWEEPS; sweep++) {
		relax(sweep % 2 === 0 ? layers : [...layers].reverse());
	}
	return centers;
}

function edgeGapLayer(input: { from: number; to: number; layers: readonly number[] }) {
	const low = Math.min(input.from, input.to);
	return input.layers.includes(low) ? low : input.layers[0];
}

function layerColumns<N extends LayoutNode>(input: {
	layers: LayerOrder<N>;
	edges: readonly LayoutEdge[];
	layerOf: ReadonlyMap<string, number>;
	metrics: LayoutMetrics;
}) {
	const { layers, edges, layerOf, metrics } = input;
	const numbers = layers.map(([layer]) => layer);
	const wideAfter = new Set<number>();
	for (const edge of edges) {
		if (!edge.wide) continue;
		const from = layerOf.get(edge.from);
		const to = layerOf.get(edge.to);
		if (from === undefined || to === undefined) continue;
		const gap = edgeGapLayer({ from, to, layers: numbers });
		if (gap !== undefined) wideAfter.add(gap);
	}
	const columns = new Map<number, { x: number; width: number; gapAfter: number }>();
	let x = metrics.sidePadding;
	for (const [layer, nodes] of layers) {
		const width = Math.max(...nodes.map((node) => node.width));
		const gapAfter = wideAfter.has(layer) ? metrics.wideLayerGap : metrics.layerGap;
		columns.set(layer, { x, width, gapAfter });
		x += width + gapAfter;
	}
	return { columns, wideAfter };
}

function assignPorts<N extends LayoutNode>(input: {
	edges: readonly LayoutEdge[];
	placed: ReadonlyMap<string, { node: N; x: number; y: number }>;
}) {
	const { edges, placed } = input;
	const buckets = new Map<string, { edge: LayoutEdge; otherY: number }[]>();
	const add = (key: string, edge: LayoutEdge, otherY: number) => {
		const bucket = buckets.get(key);
		if (bucket) bucket.push({ edge, otherY });
		else buckets.set(key, [{ edge, otherY }]);
	};
	const portSide = (edge: LayoutEdge) => {
		const from = placed.get(edge.from);
		const to = placed.get(edge.to);
		if (!from || !to) return undefined;
		if (from.node.layer === to.node.layer) return { from, to, fromSide: "r", toSide: "r" };
		return from.node.layer < to.node.layer
			? { from, to, fromSide: "r", toSide: "l" }
			: { from, to, fromSide: "l", toSide: "r" };
	};
	for (const edge of edges) {
		const side = portSide(edge);
		if (!side) continue;
		add(`${edge.from}|${side.fromSide}`, edge, side.to.y + side.to.node.height / 2);
		add(`${edge.to}|${side.toSide}`, edge, side.from.y + side.from.node.height / 2);
	}
	const offsets = new Map<string, number>();
	for (const [key, bucket] of buckets) {
		const owner = placed.get(key.slice(0, key.lastIndexOf("|")));
		const height = owner?.node.height ?? 0;
		bucket.sort((left, right) => left.otherY - right.otherY);
		const slots = [...new Set(bucket.map((entry) => entry.edge.label ?? entry))];
		const limit = Math.max(0, height / 2 - PORT_MARGIN);
		const spacing = Math.min(PORT_SPACING, slots.length > 1 ? (limit * 2) / (slots.length - 1) : 0);
		for (const entry of bucket) {
			const slot = slots.indexOf(entry.edge.label ?? entry);
			const offset = (slot - (slots.length - 1) / 2) * spacing;
			offsets.set(`${key}|${entry.edge.from}|${entry.edge.to}`, offset);
		}
	}
	return { offsets, portSide };
}

function cubic(input: {
	x1: number;
	y1: number;
	c1x: number;
	c2x: number;
	x2: number;
	y2: number;
}) {
	const { x1, y1, c1x, c2x, x2, y2 } = input;
	return {
		path: `M${x1} ${y1}C${c1x} ${y1} ${c2x} ${y2} ${x2} ${y2}`,
		midX: (x1 + 3 * c1x + 3 * c2x + x2) / 8,
		midY: (y1 + y2) / 2,
		endX: x2,
		endY: y2,
	};
}

function routeEdges<N extends LayoutNode, E extends LayoutEdge>(input: {
	edges: readonly E[];
	placed: ReadonlyMap<string, PlacedNode<N>>;
}) {
	const { offsets, portSide } = assignPorts(input);
	const routed: PlacedEdge<E>[] = [];
	for (const edge of input.edges) {
		const side = portSide(edge);
		if (!side || edge.from === edge.to) continue;
		const { from, to, fromSide, toSide } = side;
		const startOffset = offsets.get(`${edge.from}|${fromSide}|${edge.from}|${edge.to}`) ?? 0;
		const endOffset = offsets.get(`${edge.to}|${toSide}|${edge.from}|${edge.to}`) ?? 0;
		const y1 = from.y + from.node.height / 2 + startOffset;
		const y2 = to.y + to.node.height / 2 + endOffset;
		if (from.node.layer === to.node.layer) {
			const x = from.x + from.node.width;
			const bulge = 28 + Math.abs(y2 - y1) * 0.15;
			routed.push({
				edge,
				shape: "same",
				...cubic({ x1: x, y1, c1x: x + bulge, c2x: x + bulge, x2: to.x + to.node.width, y2 }),
			});
		} else if (from.node.layer < to.node.layer) {
			const x1 = from.x + from.node.width;
			const x2 = to.x;
			const pull = Math.max(32, (x2 - x1) * 0.5);
			routed.push({
				edge,
				shape: "forward",
				...cubic({ x1, y1, c1x: x1 + pull, c2x: x2 - pull, x2, y2 }),
			});
		} else {
			const x1 = from.x;
			const x2 = to.x + to.node.width;
			const pull = Math.max(32, (x1 - x2) * 0.5);
			routed.push({
				edge,
				shape: "back",
				...cubic({ x1, y1, c1x: x1 - pull, c2x: x2 + pull, x2, y2 }),
			});
		}
	}
	return routed;
}

function placeLabels<N extends LayoutNode, E extends LayoutEdge>(input: {
	routed: readonly PlacedEdge<E>[];
	placed: ReadonlyMap<string, PlacedNode<N>>;
	columns: ReadonlyMap<number, { x: number; width: number; gapAfter: number }>;
	metrics: LayoutMetrics;
}) {
	const { routed, placed, columns, metrics } = input;
	const groups = new Map<string, { text: string; gap: number; members: PlacedEdge<E>[] }>();
	for (const entry of routed) {
		const text = entry.edge.label;
		const from = placed.get(entry.edge.from);
		const to = placed.get(entry.edge.to);
		if (!text || !from || !to) continue;
		const gap = Math.min(from.node.layer, to.node.layer);
		const key = `${gap}|${text}|${entry.edge.to}`;
		const group = groups.get(key);
		if (group) group.members.push(entry);
		else groups.set(key, { text, gap, members: [entry] });
	}
	const byGap = new Map<
		number,
		{ text: string; desired: number; edges: E[]; forward: boolean }[]
	>();
	for (const group of groups.values()) {
		const first = group.members[0];
		const target = first ? placed.get(first.edge.to) : undefined;
		const desired = target ? target.y + target.node.height / 2 : 0;
		const item = {
			text: group.text,
			desired,
			edges: group.members.map((member) => member.edge),
			forward: first?.shape !== "back",
		};
		const bucket = byGap.get(group.gap);
		if (bucket) bucket.push(item);
		else byGap.set(group.gap, [item]);
	}
	const labels: PlacedLabel<E>[] = [];
	for (const [gap, items] of byGap) {
		const column = columns.get(gap);
		if (!column) continue;
		items.sort((left, right) => left.desired - right.desired);
		const centers = resolveOverlaps({
			desired: items.map((item) => item.desired),
			sizes: items.map(() => metrics.labelHeight),
			gap: 4,
		});
		const width = column.gapAfter - LABEL_MARGIN * 2;
		items.forEach((item, index) => {
			labels.push({
				text: item.text,
				edges: item.edges,
				width,
				align: item.forward ? "end" : "start",
				x: column.x + column.width + LABEL_MARGIN,
				y: (centers[index] ?? item.desired) - metrics.labelHeight / 2,
			});
		});
	}
	return labels;
}

export function layoutGraph<N extends LayoutNode, E extends LayoutEdge>(input: {
	nodes: readonly N[];
	edges: readonly E[];
	metrics?: Partial<LayoutMetrics>;
}): GraphLayout<N, E> {
	const metrics = { ...DEFAULT_METRICS, ...input.metrics };
	const known = new Set(input.nodes.map((node) => node.id));
	const edges = input.edges.filter((edge) => known.has(edge.from) && known.has(edge.to));
	if (input.nodes.length === 0) {
		return { nodes: [], edges: [], labels: [], bands: [], width: 0, height: 0 };
	}
	const layers = orderLayers({ nodes: input.nodes, edges });
	const centers = positionNodes({ layers, edges, nodeGap: metrics.nodeGap });
	const layerOf = new Map(input.nodes.map((node) => [node.id, node.layer]));
	const { columns, wideAfter } = layerColumns({ layers, edges, layerOf, metrics });
	const minY = Math.min(
		...input.nodes.map((node) => (centers.get(node.id) ?? 0) - node.height / 2),
	);
	const placed = new Map<string, PlacedNode<N>>();
	const nodes: PlacedNode<N>[] = [];
	for (const [layer, members] of layers) {
		const column = columns.get(layer);
		for (const node of members) {
			const entry: PlacedNode<N> = {
				node,
				x: (column?.x ?? 0) + ((column?.width ?? node.width) - node.width) / 2,
				y: (centers.get(node.id) ?? 0) - node.height / 2 - minY + metrics.padding,
			};
			placed.set(node.id, entry);
			nodes.push(entry);
		}
	}
	const routed = routeEdges({ edges, placed });
	const labels = placeLabels({ routed, placed, columns, metrics });
	const lastColumn = layers.at(-1);
	const last = lastColumn ? columns.get(lastColumn[0]) : undefined;
	const contentBottom = Math.max(
		...nodes.map((entry) => entry.y + entry.node.height),
		...labels.map((label) => label.y + metrics.labelHeight),
	);
	const minLabelY = Math.min(metrics.padding, ...labels.map((label) => label.y));
	const shift = metrics.padding - minLabelY;
	const bands: WireBand[] = [...wideAfter].flatMap((layer) => {
		const column = columns.get(layer);
		if (!column) return [];
		return [{ afterLayer: layer, x: column.x + column.width + 8, width: column.gapAfter - 16 }];
	});
	return {
		nodes: nodes.map((entry) => ({ ...entry, y: entry.y + shift })),
		edges: shift === 0 ? routed : routeEdges({ edges, placed: shiftPlaced(placed, shift) }),
		labels: labels.map((label) => ({ ...label, y: label.y + shift })),
		bands,
		width: (last?.x ?? 0) + (last?.width ?? 0) + metrics.sidePadding,
		height: contentBottom + shift + metrics.padding,
	};
}

function shiftPlaced<N extends LayoutNode>(
	placed: ReadonlyMap<string, PlacedNode<N>>,
	shift: number,
) {
	return new Map([...placed].map(([id, entry]) => [id, { ...entry, y: entry.y + shift }] as const));
}
