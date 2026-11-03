import { useMemo } from "react";
import type { SymbolId } from "../../core/types";
import { SplitWithSource } from "../components/SplitWithSource";
import { StartPicker } from "../components/StartPicker";
import { InlineMessage } from "../components/States";
import { buildFlow, type Flow, type FlowStep } from "../lib/flow";
import { displayName, plural, shortModule } from "../lib/format";
import { type FlowRoute, flowHref, formatHash, MAX_FLOW_DEPTH, MIN_FLOW_DEPTH } from "../lib/route";
import { useGraph, useWorkspace } from "../lib/workspace";

const LANE_WIDTH = 164;
const LABEL_ROOM = LANE_WIDTH * 2;
const ROW_HEIGHT = 28;
const LANE_LEFT = 128;
const SELF_LOOP = 22;
const ACTIVATION_WIDTH = 6;
const ARROW_OFFSET = 20;

function laneX(lane: number) {
	return LANE_LEFT + lane * LANE_WIDTH;
}

function stepLabel(step: FlowStep) {
	const name = displayName(step.to);
	if (step.wire) return step.label ?? name;
	if (step.kind === "render") return `<${name}>`;
	if (step.kind === "new") return `new ${name}`;
	if (step.kind === "implements") return `impl ${name}`;
	return `${name}()`;
}

function arrowPath(step: FlowStep, y: number) {
	const from = laneX(step.fromLane);
	const to = laneX(step.toLane);
	if (step.fromLane === step.toLane) {
		return `M${from} ${y - 6}h${SELF_LOOP}v8h-${SELF_LOOP - 8}`;
	}
	const direction = to > from ? -1 : 1;
	return `M${from} ${y}L${to + direction * 8} ${y}`;
}

function labelBox(step: FlowStep) {
	if (step.fromLane === step.toLane) {
		const left = laneX(step.fromLane) + SELF_LOOP + 6;
		return { left, maxWidth: LABEL_ROOM };
	}
	const start = Math.min(laneX(step.fromLane), laneX(step.toLane));
	const span = Math.abs(step.toLane - step.fromLane) * LANE_WIDTH;
	return { left: start + 12, maxWidth: Math.max(span - 24, LABEL_ROOM) };
}

function Diagram(props: { flow: Flow; route: FlowRoute }) {
	const { flow, route } = props;
	const { packages } = useWorkspace();
	const width = laneX(flow.lanes.length - 1) + LABEL_ROOM + SELF_LOOP;
	const height = flow.steps.length * ROW_HEIGHT + 16;
	return (
		<div className="flow-scroll">
			<div className="flow-canvas" style={{ width, minHeight: height + 40 }}>
				<div className="flow-lanes" style={{ width }}>
					<span className="flow-depth-head" title="Call depth of each step">
						depth
					</span>
					{flow.lanes.map((lane) => {
						const slot = packages.slotOf(lane.module);
						return (
							<div
								key={lane.module}
								className="flow-lane-head"
								style={{ left: laneX(lane.index) - LANE_WIDTH / 2 + 4, width: LANE_WIDTH - 8 }}
								title={lane.module}
							>
								<span
									className={`pkg-swatch ${slot === undefined ? "pkg-other" : `pkg-${slot}`}`}
								/>
								<span className="flow-lane-name">{shortModule(lane.module)}</span>
							</div>
						);
					})}
				</div>
				<div className="flow-body" style={{ height }}>
					<svg className="flow-svg" width={width} height={height} aria-hidden="true">
						<defs>
							<marker
								id="flow-arrow"
								viewBox="0 0 8 8"
								refX="7"
								refY="4"
								markerWidth="8"
								markerHeight="8"
								orient="auto"
							>
								<path d="M0 0 8 4 0 8Z" className="arrow-call" />
							</marker>
							<marker
								id="flow-arrow-wire"
								viewBox="0 0 8 8"
								refX="7"
								refY="4"
								markerWidth="5"
								markerHeight="5"
								orient="auto"
							>
								<path d="M0 0 8 4 0 8Z" className="arrow-wire" />
							</marker>
						</defs>
						{flow.lanes.map((lane) => (
							<line
								key={lane.module}
								className="flow-lifeline"
								x1={laneX(lane.index)}
								x2={laneX(lane.index)}
								y1={0}
								y2={height}
							/>
						))}
						{flow.steps.map((step) => {
							const y = step.row * ROW_HEIGHT + ARROW_OFFSET;
							const expandedSpan = step.endRow > step.row;
							return (
								<g key={step.row}>
									{expandedSpan ? (
										<rect
											className="flow-activation"
											x={laneX(step.toLane) - ACTIVATION_WIDTH / 2 + (step.depth - 1)}
											y={y}
											width={ACTIVATION_WIDTH}
											height={(step.endRow - step.row) * ROW_HEIGHT + ROW_HEIGHT - ARROW_OFFSET + 4}
										/>
									) : null}
									<path
										d={arrowPath(step, y)}
										className={step.wire ? "flow-arrow flow-arrow-wire" : "flow-arrow"}
										markerEnd={step.wire ? "url(#flow-arrow-wire)" : "url(#flow-arrow)"}
										fill="none"
									/>
								</g>
							);
						})}
					</svg>
					{flow.steps.map((step) => {
						const selected = route.selected === step.to.id;
						const box = labelBox(step);
						return (
							<a
								key={step.row}
								className={`flow-row${step.wire ? " flow-row-wire" : ""}${selected ? " flow-row-selected" : ""}`}
								href={formatHash({ ...route, selected: step.to.id })}
								style={{ top: step.row * ROW_HEIGHT, height: ROW_HEIGHT }}
								title={`${step.from.file}:${step.line} calls ${step.to.id}`}
							>
								<span className="flow-gutter">{step.depth}</span>
								<span
									className={step.wire ? "flow-label flow-label-wire" : "flow-label"}
									style={box}
								>
									{step.wire ? <span className="wire-pill-kind">wire</span> : null}
									<span className="flow-label-text">{stepLabel(step)}</span>
									{step.repeated ? <span className="flow-seen">seen above</span> : null}
								</span>
							</a>
						);
					})}
				</div>
			</div>
		</div>
	);
}

export function FlowView(props: { route: FlowRoute }) {
	const { route } = props;
	const index = useGraph(route.side);
	const { symbol: root } = route;
	const flow = useMemo(
		() =>
			root ? buildFlow({ index, root, depth: route.depth, utilities: route.utilities }) : undefined,
		[index, root, route.depth, route.utilities],
	);
	const hrefForPick = (id: SymbolId) => flowHref(id, route.side);
	if (!root) {
		return (
			<StartPicker
				title="Pick a symbol to follow"
				detail="Flow follows calls depth-first in source order, with one lifeline per module. It is the call stack, drawn."
				hrefFor={hrefForPick}
			/>
		);
	}
	const rootSymbol = index.symbols.get(root);
	if (!rootSymbol || !flow) {
		return (
			<div className="view-center">
				<InlineMessage title="This symbol is not in the graph">
					<p>
						<code>{root}</code> does not exist on the {route.side} side.
					</p>
				</InlineMessage>
			</div>
		);
	}
	const selected = (route.selected && index.symbols.get(route.selected)) || rootSymbol;
	const wires = flow.steps.filter((step) => step.wire).length;
	return (
		<SplitWithSource
			symbol={selected}
			side={route.side}
			active="flow"
			linkFor={(target) => formatHash({ ...route, selected: target })}
		>
			{(sourceToggle) => (
				<>
					<div className="graph-toolbar">
						<span className="graph-title" title={root}>
							{displayName(rootSymbol)}
						</span>
						<fieldset className="stepper">
							<legend className="stepper-label">Depth</legend>
							<a
								className="stepper-button"
								aria-label="Less depth"
								aria-disabled={route.depth <= MIN_FLOW_DEPTH}
								href={formatHash({ ...route, depth: Math.max(MIN_FLOW_DEPTH, route.depth - 1) })}
							>
								-
							</a>
							<span className="stepper-value">{route.depth}</span>
							<a
								className="stepper-button"
								aria-label="More depth"
								aria-disabled={route.depth >= MAX_FLOW_DEPTH}
								href={formatHash({ ...route, depth: Math.min(MAX_FLOW_DEPTH, route.depth + 1) })}
							>
								+
							</a>
						</fieldset>
						<label className="toggle">
							<input
								type="checkbox"
								checked={route.utilities}
								onChange={(event) => {
									window.location.hash = formatHash({ ...route, utilities: event.target.checked });
								}}
							/>
							Utilities{flow.hiddenUtilities > 0 ? ` (${flow.hiddenUtilities} hidden)` : ""}
						</label>
						<span className="graph-stats">
							{plural(flow.steps.length, "step")}, {plural(flow.lanes.length, "module")},{" "}
							{plural(wires, "wire crossing")}
						</span>
						<span className="toolbar-end">{sourceToggle}</span>
					</div>
					{flow.truncated ? (
						<div className="notice">
							Stopped at {flow.steps.length} steps. Lower the depth to see the whole flow.
						</div>
					) : null}
					{flow.steps.length === 0 ? (
						<div className="view-center">
							<InlineMessage title="This symbol calls nothing in the repo">
								<p>Flow follows outgoing calls. Open Trace to see who calls it.</p>
							</InlineMessage>
						</div>
					) : (
						<Diagram flow={flow} route={route} />
					)}
				</>
			)}
		</SplitWithSource>
	);
}
