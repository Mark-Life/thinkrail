import { useMemo } from "react";
import type { CodeSymbol, SymbolId } from "../../core/types";
import { startingPoints } from "../lib/graphIndex";
import { useWorkspace } from "../lib/workspace";
import { SymbolRow } from "./SymbolList";

function Column(props: {
	title: string;
	symbols: readonly CodeSymbol[];
	hrefFor: (id: SymbolId) => string;
}) {
	return (
		<section className="picker-column">
			<h3 className="section-title">{props.title}</h3>
			<ul className="symbol-list">
				{props.symbols.map((symbol) => (
					<SymbolRow key={symbol.id} symbol={symbol} href={props.hrefFor(symbol.id)} />
				))}
			</ul>
		</section>
	);
}

export function StartPicker(props: {
	title: string;
	detail: string;
	hrefFor: (id: SymbolId) => string;
}) {
	const { head } = useWorkspace();
	const points = useMemo(() => startingPoints(head), [head]);
	return (
		<div className="picker">
			<h2 className="picker-title">{props.title}</h2>
			<p className="picker-detail">{props.detail}</p>
			<div className="picker-grid">
				<Column title="Most used wire handlers" symbols={points.handlers} hrefFor={props.hrefFor} />
				<Column title="Largest components" symbols={points.components} hrefFor={props.hrefFor} />
				<Column title="Most used hooks" symbols={points.hooks} hrefFor={props.hrefFor} />
			</div>
		</div>
	);
}
