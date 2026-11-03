type NavDirection = "left" | "right" | "up" | "down";

interface NavNode {
	id: string;
	layer: number;
	y: number;
	height: number;
}

export function nearestInDirection(input: {
	nodes: readonly NavNode[];
	from: string;
	direction: NavDirection;
}) {
	const { nodes, from, direction } = input;
	const current = nodes.find((node) => node.id === from);
	if (!current) return undefined;
	const centerOf = (node: NavNode) => node.y + node.height / 2;
	if (direction === "up" || direction === "down") {
		const peers = nodes
			.filter((node) => node.layer === current.layer)
			.sort((left, right) => left.y - right.y);
		const position = peers.findIndex((node) => node.id === from);
		return peers[position + (direction === "up" ? -1 : 1)]?.id;
	}
	const candidates = nodes.filter((node) =>
		direction === "left" ? node.layer < current.layer : node.layer > current.layer,
	);
	if (candidates.length === 0) return undefined;
	const nearestLayer =
		direction === "left"
			? Math.max(...candidates.map((node) => node.layer))
			: Math.min(...candidates.map((node) => node.layer));
	return candidates
		.filter((node) => node.layer === nearestLayer)
		.sort(
			(left, right) =>
				Math.abs(centerOf(left) - centerOf(current)) -
				Math.abs(centerOf(right) - centerOf(current)),
		)[0]?.id;
}
