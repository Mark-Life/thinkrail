import { useT } from "@thinkrail/locales/react";
import { cn } from "@thinkrail/ui/utils";
import { selectFileBufferSummary, useAppStore } from "../store";

export function FileDirtyDot({ workspaceId, path }: { workspaceId: string; path: string }) {
	const t = useT();
	const status = useAppStore((state) => {
		const summary = selectFileBufferSummary(state, workspaceId, path);
		return summary?.dirty === true ? summary.status : null;
	});
	if (status === null) return null;
	return (
		<span
			role="img"
			data-testid="file-dirty-dot"
			data-status={status}
			aria-label={t("shell.workbench.unsaved")}
			className={cn(
				"mr-4 size-8 shrink-0 rounded-full bg-text-default forced-colors:bg-[CanvasText] forced-colors:forced-color-adjust-none",
				status === "saving" && "animate-pulse motion-reduce:animate-none",
			)}
		/>
	);
}
