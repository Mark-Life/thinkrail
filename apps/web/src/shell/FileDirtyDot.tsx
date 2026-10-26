import { useT } from "@thinkrail/locales/react";
import { cn } from "@thinkrail/ui/utils";
import { selectFileSaveIndicator, useAppStore } from "../store";

export function FileDirtyDot({ workspaceId, path }: { workspaceId: string; path: string }) {
	const t = useT();
	const indicator = useAppStore((state) => selectFileSaveIndicator(state, workspaceId, path));
	const autosaving = useAppStore((state) => state.fileSaveMode === "auto");
	if (indicator === null) return null;
	if (indicator === "pending") {
		return (
			<span
				role="img"
				data-testid="file-save-pending"
				aria-label={t("shell.workbench.autosavePending")}
				className="mr-4 size-8 shrink-0 animate-pulse rounded-full border-2 border-feedback-info motion-reduce:animate-none forced-colors:border-[CanvasText] forced-colors:forced-color-adjust-none"
			/>
		);
	}
	return (
		<span
			role="img"
			data-testid="file-dirty-dot"
			data-status={indicator}
			aria-label={t(autosaving ? "shell.workbench.autosavePaused" : "shell.workbench.unsaved")}
			className={cn(
				"mr-4 size-8 shrink-0 rounded-full bg-text-default forced-colors:bg-[CanvasText] forced-colors:forced-color-adjust-none",
				indicator === "saving" && "animate-pulse motion-reduce:animate-none",
			)}
		/>
	);
}
