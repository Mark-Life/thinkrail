import { type ResourceHtmlMode, useOptionalResourceHost } from "../../host";
import type { ResourceDescriptor } from "../../registry";

export function useHtmlMode({
	workspaceId,
	path,
}: Pick<ResourceDescriptor, "workspaceId" | "path">): ResourceHtmlMode {
	return useOptionalResourceHost()?.html?.mode(workspaceId, path) ?? "static";
}
