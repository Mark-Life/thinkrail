import type { CodeSymbol } from "../../core/types";
import type { Flow, FlowStep } from "./flow";

interface WaterfallRowBase {
	key: number;
	symbol: CodeSymbol;
	depth: number;
	start: number;
	span: number;
	callsInside: number;
}

export type WaterfallRow =
	| (WaterfallRowBase & { kind: "root" })
	| (WaterfallRowBase & { kind: "step"; step: FlowStep });

export interface Waterfall {
	rows: WaterfallRow[];
	total: number;
}

export function buildWaterfall(flow: Flow) {
	const total = flow.steps.length + 1;
	const root: WaterfallRow = {
		kind: "root",
		key: 0,
		symbol: flow.root,
		depth: 0,
		start: 0,
		span: total,
		callsInside: flow.steps.length,
	};
	const steps = flow.steps.map((step): WaterfallRow => {
		const callsInside = step.endRow - step.row;
		return {
			kind: "step",
			step,
			key: step.row + 1,
			symbol: step.to,
			depth: step.depth,
			start: step.row + 1,
			span: callsInside + 1,
			callsInside,
		};
	});
	const waterfall: Waterfall = { rows: [root, ...steps], total };
	return waterfall;
}

export function visibleWaterfallRows(input: {
	rows: readonly WaterfallRow[];
	collapsed: ReadonlySet<number>;
}) {
	let hiddenUntil = -1;
	return input.rows.filter((row) => {
		if (row.start < hiddenUntil) return false;
		if (input.collapsed.has(row.key)) hiddenUntil = row.start + row.span;
		return true;
	});
}
