import { useState } from "react";
import type { CodeSymbol, Edge, GraphSide, SymbolId } from "../../core/types";
import { displayName, kindLabel, shortModule } from "../lib/format";
import { isWireEdge } from "../lib/graphIndex";
import { symbolHref } from "../lib/route";
import { useGraph } from "../lib/workspace";

const DEFAULT_CAP = 30;

function CappedList<T>(props: {
	items: readonly T[];
	cap?: number;
	renderItem: (item: T) => React.ReactNode;
	emptyText: string;
}) {
	const [showAll, setShowAll] = useState(false);
	const cap = props.cap ?? DEFAULT_CAP;
	if (props.items.length === 0) return <p className="list-empty">{props.emptyText}</p>;
	const shown = showAll ? props.items : props.items.slice(0, cap);
	return (
		<>
			<ul className="symbol-list">{shown.map(props.renderItem)}</ul>
			{props.items.length > cap && !showAll ? (
				<button type="button" className="text-button" onClick={() => setShowAll(true)}>
					Show all {props.items.length}
				</button>
			) : null}
		</>
	);
}

export function SymbolRow(props: {
	symbol: CodeSymbol;
	side?: GraphSide | undefined;
	href?: string;
	mark?: string | undefined;
	markClass?: string | undefined;
	tag?: string | undefined;
	active?: boolean;
}) {
	const { symbol } = props;
	return (
		<li>
			<a
				className={props.active ? "symbol-row symbol-row-active" : "symbol-row"}
				href={props.href ?? symbolHref(symbol.id, props.side)}
				title={`${symbol.file}:${symbol.startLine}`}
				aria-current={props.active ? "true" : undefined}
			>
				{props.mark ? (
					<span className={`status-mark ${props.markClass ?? ""}`}>{props.mark}</span>
				) : null}
				<span className="kind-badge">{kindLabel(symbol.kind)}</span>
				<span className="symbol-row-name">{displayName(symbol)}</span>
				{props.tag ? <span className="wire-tag">{props.tag}</span> : null}
				<span className="symbol-row-module">{shortModule(symbol.module)}</span>
			</a>
		</li>
	);
}

export function SymbolList(props: {
	symbols: readonly CodeSymbol[];
	side?: GraphSide | undefined;
	emptyText: string;
	cap?: number;
}) {
	return (
		<CappedList
			items={props.symbols}
			emptyText={props.emptyText}
			{...(props.cap === undefined ? {} : { cap: props.cap })}
			renderItem={(symbol) => <SymbolRow key={symbol.id} symbol={symbol} side={props.side} />}
		/>
	);
}

function uniqueEndpoints(edges: readonly Edge[], pick: (edge: Edge) => SymbolId) {
	const seen = new Map<SymbolId, Edge>();
	for (const edge of edges) {
		const id = pick(edge);
		const existing = seen.get(id);
		if (!existing || (isWireEdge(edge) && !isWireEdge(existing))) seen.set(id, edge);
	}
	return [...seen.entries()];
}

export function EdgeList(props: {
	edges: readonly Edge[];
	pick: (edge: Edge) => SymbolId;
	side?: GraphSide | undefined;
	emptyText: string;
}) {
	const index = useGraph(props.side ?? "head");
	const rows = uniqueEndpoints(props.edges, props.pick)
		.flatMap(([id, edge]) => {
			const symbol = index.symbols.get(id);
			return symbol ? [{ symbol, edge }] : [];
		})
		.sort((left, right) => {
			const wire = Number(isWireEdge(right.edge)) - Number(isWireEdge(left.edge));
			const test = Number(left.symbol.isTest) - Number(right.symbol.isTest);
			return wire || test || left.symbol.name.localeCompare(right.symbol.name);
		});
	return (
		<CappedList
			items={rows}
			emptyText={props.emptyText}
			renderItem={({ symbol, edge }) => (
				<SymbolRow
					key={symbol.id}
					symbol={symbol}
					side={props.side}
					tag={isWireEdge(edge) && edge.label !== symbol.name ? edge.label : undefined}
				/>
			)}
		/>
	);
}
