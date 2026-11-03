import { useState } from "react";
import { changeCounts } from "../../lib/changes";
import { type ChangesRoute, formatHash } from "../../lib/route";
import { useWorkspace } from "../../lib/workspace";
import { CountMarks } from "./CountMarks";

const GROUP_CAP = 40;

export function GroupList(props: { route: ChangesRoute; activeGroup: string | undefined }) {
	const { route, activeGroup } = props;
	const { diff } = useWorkspace();
	const [showAll, setShowAll] = useState(false);
	if (!diff) return null;
	const { groups, contracts, movedOnly, formatOnlyFiles, nonCodeFiles } = diff.diff;
	const shown = showAll ? groups : groups.slice(0, GROUP_CAP);
	const sectionLink = (section: ChangesRoute["section"]) =>
		formatHash({ view: "changes", section, tab: "calls" });
	const moved = movedOnly.length + formatOnlyFiles.length;
	return (
		<nav className="group-list" aria-label="Change groups">
			<h2 className="section-title group-list-title">
				Groups <span className="section-count">{groups.length}</span>
			</h2>
			<ul className="group-items">
				{shown.map((group) => {
					const active = route.section === "groups" && group.id === activeGroup;
					return (
						<li key={group.id}>
							<a
								className={active ? "group-item group-item-active" : "group-item"}
								href={formatHash({
									view: "changes",
									section: "groups",
									group: group.id,
									tab: route.tab,
								})}
								aria-current={active ? "true" : undefined}
								title={group.title}
							>
								<span className="group-item-title">{group.title}</span>
								<CountMarks counts={changeCounts(group.symbolChanges)} />
							</a>
						</li>
					);
				})}
			</ul>
			{groups.length > GROUP_CAP && !showAll ? (
				<button type="button" className="text-button" onClick={() => setShowAll(true)}>
					Show all {groups.length}
				</button>
			) : null}
			<div className="group-sections">
				<a
					className={route.section === "contracts" ? "group-item group-item-active" : "group-item"}
					href={sectionLink("contracts")}
				>
					<span className="group-item-title">Contracts</span>
					<span className="section-count">{contracts.length}</span>
				</a>
				<a
					className={route.section === "moved" ? "group-item group-item-active" : "group-item"}
					href={sectionLink("moved")}
				>
					<span className="group-item-title group-item-quiet">Moved or format only</span>
					<span className="section-count">{moved}</span>
				</a>
				<a
					className={route.section === "non-code" ? "group-item group-item-active" : "group-item"}
					href={sectionLink("non-code")}
				>
					<span className="group-item-title group-item-quiet">Non-code files</span>
					<span className="section-count">{nonCodeFiles.length}</span>
				</a>
			</div>
		</nav>
	);
}
