import { useSyncExternalStore } from "react";
import { type ResourceHtmlMode, useOptionalResourceHost } from "../../host";
import type { ResourceDescriptor } from "../../registry";

const noSubscription = () => () => {};

export function useHtmlMode({
	workspaceId,
	path,
	scope,
}: Pick<ResourceDescriptor, "workspaceId" | "path" | "scope">): ResourceHtmlMode {
	const html = useOptionalResourceHost()?.html;
	const read = () => html?.mode(workspaceId, path) ?? "static";
	const mode = useSyncExternalStore(html?.subscribe ?? noSubscription, read, read);
	return mode === "scripted" && scope !== undefined ? "themed" : mode;
}
