import { SourcePane } from "../components/SourcePane";
import { InlineMessage } from "../components/States";
import { SymbolList } from "../components/SymbolList";
import { formatCount } from "../lib/format";
import { type FileRoute, mapHref } from "../lib/route";
import { useGraph } from "../lib/workspace";

export function FileView(props: { route: FileRoute }) {
	const { file, side, line } = props.route;
	const index = useGraph(side);
	const info = index.files.get(file);
	if (!info) {
		return (
			<div className="view-center">
				<InlineMessage title="This file is not in the graph">
					<p>
						<code>{file}</code> was not indexed on the {side} side.
					</p>
				</InlineMessage>
			</div>
		);
	}
	const symbols = (index.fileSymbols.get(file) ?? []).filter((symbol) => symbol.kind !== "module");
	return (
		<div className="symbol-view">
			<div className="symbol-side">
				<div className="symbol-header">
					<h2 className="symbol-title">{file.slice(file.lastIndexOf("/") + 1)}</h2>
					<div className="symbol-meta">
						<a className="muted-link" href={mapHref({ path: info.module, file })}>
							{info.module}
						</a>
						<span>{formatCount(info.lines)} lines</span>
						<span>{formatCount(info.commits90d)} commits in 90 days</span>
					</div>
				</div>
				<div className="symbol-sections">
					<section>
						<h3 className="section-title">
							Symbols <span className="section-count">{symbols.length}</span>
						</h3>
						<SymbolList
							symbols={symbols}
							side={side}
							emptyText="This file declares no symbols."
							cap={60}
						/>
					</section>
				</div>
			</div>
			<SourcePane side={side} file={file} focusStart={line} focusEnd={line} />
		</div>
	);
}
