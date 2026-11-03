import { useMemo } from "react";
import { InlineMessage } from "../components/States";
import { hasCodeChanges, totalCounts } from "../lib/changes";
import { formatCount, plural } from "../lib/format";
import type { ChangesRoute } from "../lib/route";
import { useWorkspace } from "../lib/workspace";
import { ContractsSection } from "./changes/ContractsSection";
import { CountMarks } from "./changes/CountMarks";
import { GroupDetail } from "./changes/GroupDetail";
import { GroupList } from "./changes/GroupList";
import { MovedSection, NonCodeSection } from "./changes/OtherSections";

export function ChangesView(props: { route: ChangesRoute }) {
	const { route } = props;
	const { session, diff } = useWorkspace();
	const counts = useMemo(() => (diff ? totalCounts(diff.diff) : undefined), [diff]);
	if (!diff || !counts || session.mode !== "diff") {
		return (
			<div className="view-center">
				<InlineMessage title="This session has no diff">
					<p>
						Run <code>repo-map diff</code> or <code>repo-map pr &lt;number&gt;</code> to compare
						versions.
					</p>
				</InlineMessage>
			</div>
		);
	}
	const { diff: data } = diff;
	const group = route.group ? diff.groups.get(route.group) : data.groups[0];
	return (
		<div className="changes-view">
			<div className="changes-header">
				<h1 className="changes-title" title={session.title}>
					{session.title}
				</h1>
				<CountMarks counts={counts} />
				<span className="changes-stat">{plural(data.changedFiles.length, "code file")}</span>
				<span className="changes-stat">{plural(data.groups.length, "group")}</span>
				<span className="changes-stat">{formatCount(data.contracts.length)} contract changes</span>
			</div>
			{hasCodeChanges(data) ? (
				<div className="changes-body">
					<GroupList route={route} activeGroup={group?.id} />
					<div className="changes-main">
						{route.section === "contracts" ? <ContractsSection /> : null}
						{route.section === "moved" ? <MovedSection /> : null}
						{route.section === "non-code" ? <NonCodeSection /> : null}
						{route.section === "groups" && group ? (
							<GroupDetail group={group} route={route} />
						) : null}
						{route.section === "groups" && !group ? (
							<div className="view-center">
								<InlineMessage title="No change groups">
									<p>Only contracts or moved code changed. Open them from the list.</p>
								</InlineMessage>
							</div>
						) : null}
					</div>
				</div>
			) : (
				<div className="view-center">
					<InlineMessage title="No code changes between these versions">
						{data.nonCodeFiles.length > 0 ? (
							<>
								<p>{plural(data.nonCodeFiles.length, "non-code file")} changed:</p>
								<ul className="file-list">
									{data.nonCodeFiles.slice(0, 20).map((file) => (
										<li key={file}>{file}</li>
									))}
								</ul>
							</>
						) : (
							<p>The two versions have the same symbols and calls.</p>
						)}
					</InlineMessage>
				</div>
			)}
		</div>
	);
}
