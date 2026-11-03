import type { CodeSymbol, GraphSide } from "../../core/types";
import { STATUS_MARKS } from "../lib/changes";
import { displayName, kindName, shortModule } from "../lib/format";
import { isTypeLike } from "../lib/graphIndex";
import { flowHref, mapHref, symbolHref, traceHref } from "../lib/route";
import { useWorkspace } from "../lib/workspace";

export function SymbolHeader(props: {
	symbol: CodeSymbol;
	side: GraphSide;
	active?: "symbol" | "trace" | "flow";
}) {
	const { symbol, side } = props;
	const { diff } = useWorkspace();
	const status =
		side === "head" ? diff?.statusByHead.get(symbol.id) : diff?.statusByBase.get(symbol.id);
	const signature = symbol.kind === "module" || isTypeLike(symbol) ? "" : symbol.signature;
	return (
		<div className="symbol-header">
			<div className="symbol-title-row">
				{status ? (
					<span className={`status-mark status-${status}`}>{STATUS_MARKS[status]}</span>
				) : null}
				<h2 className="symbol-title" title={symbol.id}>
					{displayName(symbol)}
				</h2>
				<span className="symbol-kind">{kindName(symbol.kind)}</span>
			</div>
			<div className="symbol-meta">
				<a className="muted-link" href={mapHref({ path: symbol.module, file: symbol.file })}>
					{shortModule(symbol.module)}
				</a>
				{symbol.barrelExported ? <span className="meta-tag">public</span> : null}
				{symbol.isTest ? <span className="meta-tag">test</span> : null}
			</div>
			{signature ? <pre className="symbol-signature">{signature}</pre> : null}
			<div className="symbol-actions">
				<a
					className={props.active === "symbol" ? "button button-on" : "button"}
					href={symbolHref(symbol.id, side)}
				>
					Details
				</a>
				<a
					className={props.active === "trace" ? "button button-on" : "button"}
					href={traceHref(symbol.id, side)}
				>
					Trace
				</a>
				<a
					className={props.active === "flow" ? "button button-on" : "button"}
					href={flowHref(symbol.id, side)}
				>
					Flow
				</a>
			</div>
		</div>
	);
}
