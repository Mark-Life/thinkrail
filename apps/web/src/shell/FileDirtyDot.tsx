import type { FileSaveMode } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { cn } from "@thinkrail/ui/utils";
import { selectFileAutosaving, selectFileSaveIndicator, useAppStore } from "../store";

type Indicator = NonNullable<ReturnType<typeof selectFileSaveIndicator>>;

export function FileSaveMark({
	indicator,
	autosaving,
	mode,
}: {
	indicator: Indicator;
	autosaving: boolean;
	mode: FileSaveMode;
}) {
	const t = useT();
	if (autosaving) {
		return (
			<span
				role="img"
				data-testid="file-save-pending"
				data-status={indicator}
				aria-label={t(
					indicator === "saving" ? "shell.workbench.saving" : "shell.workbench.autosavePending",
				)}
				className="mr-4 size-8 shrink-0 animate-pulse rounded-full border-2 border-feedback-info motion-reduce:animate-none forced-colors:border-[CanvasText] forced-colors:forced-color-adjust-none"
			/>
		);
	}
	return (
		<span
			role="img"
			data-testid="file-dirty-dot"
			data-status={indicator}
			aria-label={t(mode === "auto" ? "shell.workbench.autosavePaused" : "shell.workbench.unsaved")}
			className={cn(
				"mr-4 size-8 shrink-0 rounded-full bg-text-default forced-colors:bg-[CanvasText] forced-colors:forced-color-adjust-none",
				indicator === "saving" && "animate-pulse motion-reduce:animate-none",
			)}
		/>
	);
}

export function FileDirtyDot({ workspaceId, path }: { workspaceId: string; path: string }) {
	const indicator = useAppStore((state) => selectFileSaveIndicator(state, workspaceId, path));
	const autosaving = useAppStore((state) => selectFileAutosaving(state, workspaceId, path));
	const mode = useAppStore((state) => state.fileSaveMode);
	return indicator === null ? null : (
		<FileSaveMark indicator={indicator} autosaving={autosaving} mode={mode} />
	);
}
