import { type ReactNode, useState } from "react";
import type { CodeSymbol, GraphSide, SymbolId } from "../../core/types";
import { usePaneWidth } from "../lib/hooks";
import { ResizeHandle } from "./ResizeHandle";
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
	const pane = usePaneWidth({
		storageKey: "repo-map.source-width",
		initial: 480,
		min: 280,
		roomForOthers: 340,
	});
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
		<div
			className={open && symbol ? "graph-view" : "graph-view graph-view-wide"}
			style={
				open && symbol
					? { gridTemplateColumns: `minmax(0, 1fr) 5px min(${pane.width}px, calc(100% - 200px))` }
					: undefined
			}
		>
			<div className="graph-main">{props.children(toggle)}</div>
			{open && symbol ? (
				<ResizeHandle
					label="Resize source pane"
					width={pane.width}
					direction={-1}
					onResize={pane.resize}
					onReset={pane.reset}
				/>
			) : null}
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
