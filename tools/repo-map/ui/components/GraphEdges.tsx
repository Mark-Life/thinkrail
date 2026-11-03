export interface DrawnEdge {
	key: string;
	path: string;
	className: string;
	title: string;
}

const MARKERS = ["call", "muted", "wire", "added", "removed"] as const;

export function GraphEdges(props: {
	width: number;
	height: number;
	edges: readonly DrawnEdge[];
	highlighted?: ReadonlySet<string> | undefined;
}) {
	const { highlighted } = props;
	return (
		<svg className="graph-edges" width={props.width} height={props.height} aria-hidden="true">
			<defs>
				{MARKERS.map((marker) => (
					<marker
						key={marker}
						id={`arrow-${marker}`}
						viewBox="0 0 8 8"
						refX="7"
						refY="4"
						markerWidth="7"
						markerHeight="7"
						markerUnits="userSpaceOnUse"
						orient="auto"
					>
						<path d="M0 0 8 4 0 8Z" className={`arrow-${marker}`} />
					</marker>
				))}
			</defs>
			{props.edges.map((edge) => {
				const dimmed = highlighted && !highlighted.has(edge.key);
				return (
					<path
						key={edge.key}
						d={edge.path}
						className={`${edge.className}${dimmed ? " edge-dim" : ""}`}
						fill="none"
					>
						<title>{edge.title}</title>
					</path>
				);
			})}
		</svg>
	);
}
