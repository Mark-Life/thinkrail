import { formatCount } from "../../lib/format";

export function CountMarks(props: {
	counts: { added: number; removed: number; modified: number; moved: number };
}) {
	const { added, removed, modified, moved } = props.counts;
	return (
		<span className="count-marks">
			{added > 0 ? (
				<span className="count status-added" title={`${added} added`}>
					+{formatCount(added)}
				</span>
			) : null}
			{removed > 0 ? (
				<span className="count status-removed" title={`${removed} removed`}>
					-{formatCount(removed)}
				</span>
			) : null}
			{modified > 0 ? (
				<span className="count status-modified" title={`${modified} modified`}>
					~{formatCount(modified)}
				</span>
			) : null}
			{moved > 0 ? (
				<span className="count status-moved" title={`${moved} moved`}>
					&gt;{formatCount(moved)}
				</span>
			) : null}
		</span>
	);
}
