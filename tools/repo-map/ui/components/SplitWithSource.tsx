import { type ReactNode, useState } from "react";
import type { CodeSymbol, GraphSide, SymbolId } from "../../core/types";
import { SourcePane } from "./SourcePane";
import { SymbolHeader } from "./SymbolHeader";

export function SplitWithSource(props: {
	symbol: CodeSymbol | undefined;
	side: GraphSide;
	active?: "symbol" | "trace" | "flow";
	linkFor?: (target: SymbolId) => string;
	children: (toggle: ReactNode) => ReactNode;
}) {
	const { symbol, side } = props;
	const [open, setOpen] = useState(true);
	const toggle = (
		<button
			type="button"
			className={open ? "button button-on" : "button"}
			aria-pressed={open}
			title={open ? "Hide the source pane" : "Show the source pane"}
			onClick={() => setOpen((value) => !value)}
		>
			Source
		</button>
	);
	return (
		<div className={open && symbol ? "graph-view" : "graph-view graph-view-wide"}>
			<div className="graph-main">{props.children(toggle)}</div>
			{open && symbol ? (
				<aside className="aside">
					<SymbolHeader
						symbol={symbol}
						side={side}
						{...(props.active ? { active: props.active } : {})}
					/>
					<SourcePane
						side={side}
						file={symbol.file}
						focusStart={symbol.startLine}
						focusEnd={symbol.endLine}
						linkFor={props.linkFor}
					/>
				</aside>
			) : null}
		</div>
	);
}
