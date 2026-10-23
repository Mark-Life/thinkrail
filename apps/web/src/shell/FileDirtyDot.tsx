import { useT } from "@thinkrail/locales/react";
import { selectFileBufferSummary, useAppStore } from "../store";

export function FileDirtyDot({ workspaceId, path }: { workspaceId: string; path: string }) {
	const t = useT();
	const dirty = useAppStore(
		(state) => selectFileBufferSummary(state, workspaceId, path)?.dirty === true,
	);
	if (!dirty) return null;
	return (
		<span
			role="img"
			data-testid="file-dirty-dot"
			aria-label={t("shell.workbench.unsaved")}
			className="mr-4 size-8 shrink-0 rounded-full bg-text-default"
		/>
	);
}
