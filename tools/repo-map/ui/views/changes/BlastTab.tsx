import { useMemo, useState } from "react";
import type { ChangeGroup, CodeSymbol } from "../../../core/types";
import { SymbolList } from "../../components/SymbolList";
import { groupByModule, resolveSymbols } from "../../lib/changes";
import { plural, shortModule } from "../../lib/format";
import { useWorkspace } from "../../lib/workspace";

const MODULE_CAP = 10;
const OPEN_MODULES = 2;

function ModuleGroups(props: { symbols: readonly CodeSymbol[]; emptyText: string }) {
	const [showAll, setShowAll] = useState(false);
	const groups = useMemo(() => groupByModule(props.symbols), [props.symbols]);
	if (groups.length === 0) return <p className="list-empty">{props.emptyText}</p>;
	const shown = showAll ? groups : groups.slice(0, MODULE_CAP);
	return (
		<>
			{shown.map((group, position) => (
				<details key={group.module} className="blast-module" open={position < OPEN_MODULES}>
					<summary title={group.module}>
						<span className="blast-module-name">{shortModule(group.module)}</span>
						<span className="section-count">{group.members.length}</span>
					</summary>
					<SymbolList symbols={group.members} emptyText="" cap={20} />
				</details>
			))}
			{groups.length > MODULE_CAP && !showAll ? (
				<button type="button" className="text-button" onClick={() => setShowAll(true)}>
					Show all {groups.length} modules
				</button>
			) : null}
		</>
	);
}

export function BlastTab(props: { group: ChangeGroup }) {
	const { blast } = props.group;
	const { head } = useWorkspace();
	const callers = useMemo(() => resolveSymbols({ ids: blast.callers, index: head }), [blast, head]);
	const entries = useMemo(
		() => resolveSymbols({ ids: blast.entryPoints, index: head }),
		[blast, head],
	);
	const tests = useMemo(() => resolveSymbols({ ids: blast.tests, index: head }), [blast, head]);
	const modules = new Set(callers.map((symbol) => symbol.module)).size;
	return (
		<div className="blast">
			<p className="blast-summary">
				This group reaches {plural(callers.length, "caller")} in {plural(modules, "module")},{" "}
				{plural(entries.length, "entry point")} and {plural(tests.length, "test")}.
			</p>
			{blast.truncated ? (
				<div className="notice">
					The walk stopped at its limit, so the real blast radius is larger than these lists.
				</div>
			) : null}
			<div className="blast-columns">
				<section className="blast-column">
					<h3 className="section-title">
						Callers <span className="section-count">{callers.length}</span>
					</h3>
					<ModuleGroups symbols={callers} emptyText="No callers outside this group." />
				</section>
				<section className="blast-column">
					<h3 className="section-title">
						Entry points <span className="section-count">{entries.length}</span>
					</h3>
					<ModuleGroups symbols={entries} emptyText="No entry point reached." />
				</section>
				<section className="blast-column">
					<h3 className="section-title">
						Tests <span className="section-count">{tests.length}</span>
					</h3>
					<ModuleGroups symbols={tests} emptyText="No test reaches this group." />
				</section>
			</div>
		</div>
	);
}
