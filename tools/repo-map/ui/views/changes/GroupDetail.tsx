import { useMemo, useState } from "react";
import type { ChangeGroup, SymbolChange, SymbolId } from "../../../core/types";
import { SymbolRow } from "../../components/SymbolList";
import { changeCounts, changeId, changeSide, defaultFocus, STATUS_MARKS } from "../../lib/changes";
import { baseName, plural } from "../../lib/format";
import { type ChangesRoute, type ChangesTab, formatHash } from "../../lib/route";
import { useGraph, useWorkspace } from "../../lib/workspace";
import { BlastTab } from "./BlastTab";
import { CountMarks } from "./CountMarks";
import { GroupGraphTab } from "./GroupGraphTab";
import { SourceDiffTab } from "./SourceDiffTab";

const SYMBOL_CAP = 100;

const TABS: readonly { id: ChangesTab; label: string }[] = [
	{ id: "calls", label: "Calls" },
	{ id: "blast", label: "Blast radius" },
	{ id: "source", label: "Source diff" },
];

function ChangeRow(props: {
	change: SymbolChange;
	route: ChangesRoute;
	group: ChangeGroup;
	focus: SymbolId | undefined;
}) {
	const { change, route, group, focus } = props;
	const id = changeId(change);
	const side = changeSide(change);
	const index = useGraph(side);
	const symbol = index.symbols.get(id);
	if (!symbol) return null;
	return (
		<SymbolRow
			symbol={symbol}
			active={focus === id}
			mark={STATUS_MARKS[change.kind]}
			markClass={`status-${change.kind}`}
			href={formatHash({ ...route, group: group.id, symbol: id })}
		/>
	);
}

function groupByFile(input: {
	changes: readonly SymbolChange[];
	fileOf: (change: SymbolChange) => string;
}) {
	const groups = new Map<string, SymbolChange[]>();
	for (const change of input.changes) {
		const file = input.fileOf(change);
		const bucket = groups.get(file);
		if (bucket) bucket.push(change);
		else groups.set(file, [change]);
	}
	return [...groups.entries()].sort((left, right) => right[1].length - left[1].length);
}

export function GroupDetail(props: { group: ChangeGroup; route: ChangesRoute }) {
	const { group, route } = props;
	const { diff, head, base } = useWorkspace();
	const counts = changeCounts(group.symbolChanges);
	const focus = useMemo(() => {
		if (route.symbol) return route.symbol;
		return diff ? defaultFocus({ group, diffIndex: diff }) : undefined;
	}, [route.symbol, group, diff]);
	const [showAll, setShowAll] = useState(false);
	const capped = !showAll && group.symbolChanges.length > SYMBOL_CAP;
	const files = useMemo(
		() =>
			groupByFile({
				changes: capped ? group.symbolChanges.slice(0, SYMBOL_CAP) : group.symbolChanges,
				fileOf: (change) => {
					const id = changeId(change);
					return (head.symbols.get(id) ?? base?.symbols.get(id))?.file ?? "";
				},
			}),
		[group, head, base, capped],
	);
	return (
		<div className="group-detail">
			<div className="group-header">
				<h2 className="group-title" title={group.title}>
					{group.title}
				</h2>
				<CountMarks counts={counts} />
				<span className="changes-stat">{plural(group.edgeChanges.length, "edge change")}</span>
				<div className="tabs" role="tablist" aria-label="Group views">
					{TABS.map((tab) => (
						<a
							key={tab.id}
							role="tab"
							aria-selected={route.tab === tab.id}
							className={route.tab === tab.id ? "tab tab-active" : "tab"}
							href={formatHash({ ...route, group: group.id, tab: tab.id })}
						>
							{tab.label}
						</a>
					))}
				</div>
			</div>
			<div className="group-content">
				{route.tab === "blast" ? null : (
					<div className="group-symbols">
						{files.map(([file, changes]) => (
							<section key={file}>
								<h3 className="file-heading" title={file}>
									{baseName(file)}
								</h3>
								<ul className="symbol-list">
									{changes.map((change) => (
										<ChangeRow
											key={`${change.kind}:${changeId(change)}`}
											change={change}
											route={route}
											group={group}
											focus={focus}
										/>
									))}
								</ul>
							</section>
						))}
						{capped ? (
							<button type="button" className="text-button" onClick={() => setShowAll(true)}>
								Show all {group.symbolChanges.length}
							</button>
						) : null}
					</div>
				)}
				<div className="group-tab">
					{route.tab === "calls" ? (
						<GroupGraphTab group={group} focus={focus} route={route} />
					) : null}
					{route.tab === "blast" ? <BlastTab group={group} /> : null}
					{route.tab === "source" ? <SourceDiffTab group={group} focus={focus} /> : null}
				</div>
			</div>
		</div>
	);
}
