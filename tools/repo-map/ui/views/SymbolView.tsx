import { SourcePane } from "../components/SourcePane";
import { InlineMessage } from "../components/States";
import { SymbolHeader } from "../components/SymbolHeader";
import { EdgeList, SymbolList } from "../components/SymbolList";
import { calleesOf, callersOf, isTypeLike, usedByOf } from "../lib/graphIndex";
import type { SymbolRoute } from "../lib/route";
import { useGraph } from "../lib/workspace";

export function SymbolView(props: { route: SymbolRoute }) {
	const { symbol: id, side } = props.route;
	const index = useGraph(side);
	const symbol = index.symbols.get(id);
	if (!symbol) {
		return (
			<div className="view-center">
				<InlineMessage title="This symbol is not in the graph">
					<p>
						<code>{id}</code> does not exist on the {side} side. It may have been renamed.
					</p>
				</InlineMessage>
			</div>
		);
	}
	const usedBy = usedByOf(index, id);
	const callers = callersOf(index, id).filter((edge) => edge.kind !== "implements");
	const callees = calleesOf(index, id);
	const implementedBy = (index.incoming.get(id) ?? []).filter((edge) => edge.kind === "implements");
	const implementsOf = (index.outgoing.get(id) ?? []).filter((edge) => edge.kind === "implements");
	const members = index.children.get(id) ?? [];
	const typeRefs = (index.outgoing.get(id) ?? []).filter((edge) => edge.kind === "type-ref");
	const typeLike = isTypeLike(symbol);
	return (
		<div className="symbol-view">
			<div className="symbol-side">
				<SymbolHeader symbol={symbol} side={side} active="symbol" />
				<div className="symbol-sections">
					{typeLike ? null : (
						<>
							<section>
								<h3 className="section-title">
									Callers <span className="section-count">{callers.length}</span>
								</h3>
								<EdgeList
									edges={callers}
									pick={(edge) => edge.from}
									side={side}
									emptyText="No callers found in the repo."
								/>
							</section>
							<section>
								<h3 className="section-title">
									Callees <span className="section-count">{callees.length}</span>
								</h3>
								<EdgeList
									edges={callees}
									pick={(edge) => edge.to}
									side={side}
									emptyText="Calls nothing in this repo."
								/>
							</section>
						</>
					)}
					{members.length > 0 ? (
						<section>
							<h3 className="section-title">
								Members <span className="section-count">{members.length}</span>
							</h3>
							<SymbolList symbols={members} side={side} emptyText="" />
						</section>
					) : null}
					{implementedBy.length > 0 ? (
						<section>
							<h3 className="section-title">
								Implemented by <span className="section-count">{implementedBy.length}</span>
							</h3>
							<EdgeList edges={implementedBy} pick={(edge) => edge.from} side={side} emptyText="" />
						</section>
					) : null}
					{implementsOf.length > 0 ? (
						<section>
							<h3 className="section-title">Implements</h3>
							<EdgeList edges={implementsOf} pick={(edge) => edge.to} side={side} emptyText="" />
						</section>
					) : null}
					{typeLike || usedBy.length > 0 ? (
						<section>
							<h3 className="section-title">
								Used by <span className="section-count">{usedBy.length}</span>
							</h3>
							<EdgeList
								edges={usedBy}
								pick={(edge) => edge.from}
								side={side}
								emptyText="No symbol references this type."
							/>
						</section>
					) : null}
					{typeRefs.length > 0 ? (
						<section>
							<h3 className="section-title">
								Types used <span className="section-count">{typeRefs.length}</span>
							</h3>
							<EdgeList edges={typeRefs} pick={(edge) => edge.to} side={side} emptyText="" />
						</section>
					) : null}
				</div>
			</div>
			<SourcePane
				side={side}
				file={symbol.file}
				focusStart={symbol.startLine}
				focusEnd={symbol.endLine}
			/>
		</div>
	);
}
