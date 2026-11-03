import type { CodeSymbol, EdgeKind, SymbolId } from "../../core/types";
import { displayName } from "./format";
import { type GraphIndex, isWireEdge } from "./graphIndex";

export const UTILITY_FAN_IN = 40;
const MAX_FLOW_STEPS = 400;

const FLOW_KINDS: ReadonlySet<EdgeKind> = new Set([
	"call",
	"new",
	"render",
	"wire-request",
	"wire-push",
	"tool-render",
]);

interface FlowLane {
	module: string;
	index: number;
}

export interface FlowStep {
	row: number;
	depth: number;
	from: CodeSymbol;
	to: CodeSymbol;
	kind: EdgeKind;
	label?: string;
	line: number;
	fromLane: number;
	toLane: number;
	repeated: boolean;
	wire: boolean;
	endRow: number;
}

export interface Flow {
	root: CodeSymbol;
	lanes: FlowLane[];
	steps: FlowStep[];
	truncated: boolean;
	hiddenUtilities: number;
}

interface FlowLink {
	to: SymbolId;
	kind: EdgeKind;
	line: number;
	label?: string;
}

export function stepLabel(step: FlowStep) {
	const name = displayName(step.to);
	if (step.wire) return step.label ?? name;
	if (step.kind === "render") return `<${name}>`;
	if (step.kind === "new") return `new ${name}`;
	if (step.kind === "implements") return `impl ${name}`;
	return `${name}()`;
}

function implementationsOf(index: GraphIndex, id: SymbolId) {
	return (index.incoming.get(id) ?? []).filter((edge) => edge.kind === "implements");
}

function resolveSingleImplementation(index: GraphIndex, id: SymbolId) {
	const implementations = implementationsOf(index, id);
	return implementations.length === 1 && implementations[0] ? implementations[0].from : id;
}

function flowLinks(input: { index: GraphIndex; id: SymbolId; includeTests: boolean }) {
	const { index, id, includeTests } = input;
	const direct: FlowLink[] = (index.outgoing.get(id) ?? [])
		.filter((edge) => FLOW_KINDS.has(edge.kind))
		.map((edge) => {
			const to = resolveSingleImplementation(index, edge.to);
			const link: FlowLink = { to, kind: edge.kind, line: edge.line };
			return edge.label === undefined ? link : { ...link, label: edge.label };
		});
	const implementations: FlowLink[] = implementationsOf(index, id).map((edge) => ({
		to: edge.from,
		kind: "implements",
		line: Number.MAX_SAFE_INTEGER,
		label: "impl",
	}));
	const seen = new Set<SymbolId>();
	return [...direct, ...implementations]
		.filter((link) => {
			const target = index.symbols.get(link.to);
			if (!target || link.to === id || seen.has(link.to)) return false;
			if (target.isTest && !includeTests) return false;
			seen.add(link.to);
			return true;
		})
		.sort((left, right) => left.line - right.line || left.to.localeCompare(right.to));
}

function isUtility(input: { index: GraphIndex; id: SymbolId }) {
	const callers = (input.index.incoming.get(input.id) ?? []).filter(
		(edge) => edge.kind === "call" || edge.kind === "render",
	);
	return callers.length >= UTILITY_FAN_IN;
}

export function buildFlow(input: {
	index: GraphIndex;
	root: SymbolId;
	depth: number;
	utilities: boolean;
	maxSteps?: number;
}) {
	const { index, root, depth, utilities } = input;
	const rootSymbol = index.symbols.get(root);
	if (!rootSymbol) return undefined;
	const maxSteps = input.maxSteps ?? MAX_FLOW_STEPS;
	const includeTests = rootSymbol.isTest;
	const lanes = new Map<string, FlowLane>();
	const laneOf = (module: string) => {
		const existing = lanes.get(module);
		if (existing) return existing.index;
		const lane = { module, index: lanes.size };
		lanes.set(module, lane);
		return lane.index;
	};
	laneOf(rootSymbol.module);
	const steps: FlowStep[] = [];
	const expanded = new Set<SymbolId>([root]);
	const hidden = new Set<SymbolId>();
	let truncated = false;

	const visit = (symbol: CodeSymbol, level: number) => {
		for (const link of flowLinks({ index, id: symbol.id, includeTests })) {
			if (steps.length >= maxSteps) {
				truncated = true;
				return;
			}
			const target = index.symbols.get(link.to);
			if (!target) continue;
			const wire = isWireEdge(link);
			if (!utilities && !wire && link.to !== root && isUtility({ index, id: link.to })) {
				hidden.add(link.to);
				continue;
			}
			const repeated = expanded.has(link.to);
			const base: FlowStep = {
				row: steps.length,
				depth: level,
				from: symbol,
				to: target,
				kind: link.kind,
				line: link.line,
				fromLane: laneOf(symbol.module),
				toLane: laneOf(target.module),
				repeated,
				wire,
				endRow: steps.length,
			};
			const step = link.label === undefined ? base : { ...base, label: link.label };
			steps.push(step);
			if (!repeated && level < depth) {
				expanded.add(link.to);
				visit(target, level + 1);
				step.endRow = steps.length - 1;
			}
		}
	};

	visit(rootSymbol, 1);
	const flow: Flow = {
		root: rootSymbol,
		lanes: [...lanes.values()],
		steps,
		truncated,
		hiddenUtilities: hidden.size,
	};
	return flow;
}
