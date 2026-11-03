import { formatCount, formatPercent } from "../lib/format";
import { useWorkspace } from "../lib/workspace";

export function TrustFooter() {
	const { stats } = useWorkspace().head.graph;
	const resolved = stats.resolvedInRepo + stats.resolvedExternal;
	return (
		<footer className="footer">
			<span>{formatCount(stats.files)} files indexed</span>
			<span
				title={`${formatCount(stats.callSites)} call sites, ${formatCount(stats.unresolved)} unresolved`}
			>
				{formatPercent(resolved, stats.callSites)} of call sites resolved
			</span>
			<span>
				wire: {stats.wireMethodsWithCaller}/{stats.wireMethods} methods have callers,{" "}
				{stats.wireChannelsLinked}/{stats.wireChannels} channels linked
			</span>
			<span>
				{stats.toolsLinked}/{stats.tools} tools linked to a renderer
			</span>
			<span className="footer-note">
				{formatPercent(stats.dynamicCalls, stats.callSites)} of calls are dynamic: callbacks and
				dynamic dispatch can be missing.
			</span>
		</footer>
	);
}
