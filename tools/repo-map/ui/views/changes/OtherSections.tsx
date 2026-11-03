import { InlineMessage } from "../../components/States";
import { SymbolRow } from "../../components/SymbolList";
import { STATUS_MARKS } from "../../lib/changes";
import { plural } from "../../lib/format";
import { useWorkspace } from "../../lib/workspace";

export function MovedSection() {
	const { diff, head } = useWorkspace();
	if (!diff) return null;
	const { movedOnly, formatOnlyFiles } = diff.diff;
	if (movedOnly.length === 0 && formatOnlyFiles.length === 0) {
		return (
			<div className="view-center">
				<InlineMessage title="No moved or format-only changes" />
			</div>
		);
	}
	return (
		<div className="contracts">
			<h2 className="group-title">Moved or format only</h2>
			<p className="blast-summary">
				The behavior of this code did not change, so it stays out of the groups.
			</p>
			<details className="quiet-section" open>
				<summary>{plural(movedOnly.length, "moved symbol")}</summary>
				<ul className="symbol-list">
					{movedOnly.flatMap((change) => {
						if (change.kind !== "moved") return [];
						const symbol = head.symbols.get(change.head);
						if (!symbol) return [];
						return [
							<SymbolRow
								key={change.head}
								symbol={symbol}
								mark={STATUS_MARKS.moved}
								markClass="status-moved"
							/>,
						];
					})}
				</ul>
			</details>
			<details className="quiet-section">
				<summary>{plural(formatOnlyFiles.length, "format-only file")}</summary>
				<ul className="file-list">
					{formatOnlyFiles.map((file) => (
						<li key={file}>{file}</li>
					))}
				</ul>
			</details>
		</div>
	);
}

export function NonCodeSection() {
	const { diff } = useWorkspace();
	if (!diff) return null;
	return (
		<div className="contracts">
			<h2 className="group-title">Non-code files</h2>
			<p className="blast-summary">These files changed but are not part of the symbol graph.</p>
			{diff.diff.nonCodeFiles.length === 0 ? (
				<p className="list-empty">None.</p>
			) : (
				<ul className="file-list">
					{diff.diff.nonCodeFiles.map((file) => (
						<li key={file}>{file}</li>
					))}
				</ul>
			)}
		</div>
	);
}
