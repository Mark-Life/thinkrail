import { useMemo, useState } from "react";
import { type Flow, stepLabel } from "../lib/flow";
import { displayName, shortModule } from "../lib/format";
import { type FlowRoute, formatHash } from "../lib/route";
import { buildWaterfall, visibleWaterfallRows, type WaterfallRow } from "../lib/waterfall";
import { useWorkspace } from "../lib/workspace";

const INDENT = 16;

function rowName(row: WaterfallRow) {
	return row.kind === "root" ? `${displayName(row.symbol)}()` : stepLabel(row.step);
}

function rowTitle(row: WaterfallRow) {
	if (row.kind === "root") return `${row.symbol.file}:${row.symbol.startLine}`;
	return `${row.step.from.file}:${row.step.line} calls ${row.symbol.id}`;
}

function Chevron(props: { collapsed: boolean }) {
	return (
		<svg
			className={props.collapsed ? "waterfall-chevron-closed" : undefined}
			viewBox="0 0 10 10"
			width="10"
			height="10"
			aria-hidden="true"
		>
			<path d="M2 3.5 5 7l3-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
		</svg>
	);
}

export function FlowWaterfall(props: { flow: Flow; route: FlowRoute }) {
	const { flow, route } = props;
	const { packages } = useWorkspace();
	const { rows, total } = useMemo(() => buildWaterfall(flow), [flow]);
	const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
	const visible = useMemo(() => visibleWaterfallRows({ rows, collapsed }), [rows, collapsed]);
	const toggle = (key: number) => {
		const next = new Set(collapsed);
		if (!next.delete(key)) next.add(key);
		setCollapsed(next);
	};
	return (
		<div className="waterfall">
			<div className="waterfall-head">
				<span>Call</span>
				<span className="waterfall-count">Inside</span>
				<span>Bar length: calls inside, not time</span>
			</div>
			{visible.map((row) => {
				const wire = row.kind === "step" && row.step.wire;
				const repeated = row.kind === "step" && row.step.repeated;
				const isCollapsed = collapsed.has(row.key);
				const href = formatHash({ ...route, selected: row.symbol.id });
				const selected = (route.selected ?? flow.root.id) === row.symbol.id;
				const slot = packages.slotOf(row.symbol.module);
				const pkgClass = slot === undefined ? "pkg-other" : `pkg-${slot}`;
				return (
					<div
						key={row.key}
						className={`waterfall-row${wire ? " waterfall-row-wire" : ""}${selected ? " waterfall-row-selected" : ""}`}
					>
						<div className="waterfall-call" style={{ paddingLeft: row.depth * INDENT }}>
							{row.callsInside > 0 ? (
								<button
									type="button"
									className="waterfall-toggle"
									aria-expanded={!isCollapsed}
									aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${rowName(row)}`}
									onClick={() => toggle(row.key)}
								>
									<Chevron collapsed={isCollapsed} />
								</button>
							) : (
								<span className="waterfall-toggle-space" />
							)}
							<a className="waterfall-name" href={href} title={rowTitle(row)}>
								{wire ? <span className="wire-pill-kind">wire</span> : null}
								<span className="waterfall-name-text">{rowName(row)}</span>
							</a>
							<span className="waterfall-module" title={row.symbol.module}>
								{shortModule(row.symbol.module)}
							</span>
							{repeated ? <span className="flow-seen">seen above</span> : null}
						</div>
						<span className="waterfall-count">{row.callsInside > 0 ? row.callsInside : ""}</span>
						<a
							className="waterfall-track"
							href={href}
							tabIndex={-1}
							aria-label={`Select ${rowName(row)}`}
							title={rowTitle(row)}
						>
							<span
								className={`waterfall-bar ${pkgClass}`}
								style={{
									left: `${(row.start / total) * 100}%`,
									width: `${(row.span / total) * 100}%`,
								}}
							/>
						</a>
					</div>
				);
			})}
		</div>
	);
}
