import { FILE_SAVE_MODE_PROTOCOL_VERSION, type FileSaveMode } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { cn } from "@thinkrail/ui/utils";
import { AUTOSAVE_DELAY_MS } from "@/editing";
import { platformShortcutLabel } from "@/lib";
import { toast, useAppStore } from "@/store";
import { errorText, getTransport } from "@/transport";
import { SETTINGS_ROWS_CONTAINER, SettingsRow } from "./SettingsRow";
import { SettingsSwitch } from "./SettingsSwitch";

export function FileSaveModeSwitch({
	protocolVersion,
	mode,
	onSelect,
}: {
	protocolVersion: number | null;
	mode: FileSaveMode;
	onSelect: (mode: FileSaveMode) => void;
}) {
	const t = useT();
	if (protocolVersion === null || protocolVersion < FILE_SAVE_MODE_PROTOCOL_VERSION) return null;
	return (
		<div
			data-testid="file-save-mode-control"
			className={cn(SETTINGS_ROWS_CONTAINER, "border-border-muted border-b")}
		>
			<SettingsRow
				label={t("settings.fileSaveMode.label")}
				description={t("settings.fileSaveMode.description", {
					count: AUTOSAVE_DELAY_MS / 1000,
					shortcut: platformShortcutLabel("S"),
				})}
				control={
					<SettingsSwitch
						checked={mode === "auto"}
						label={t("settings.fileSaveMode.label")}
						testId="file-save-mode-auto"
						onChange={(auto) => onSelect(auto ? "auto" : "manual")}
					/>
				}
			/>
		</div>
	);
}

export function FileSaveModeControl() {
	const t = useT();
	const mode = useAppStore((state) => state.fileSaveMode);
	const protocolVersion = useAppStore((state) => state.protocolVersion);
	const select = (fileSaveMode: FileSaveMode) => {
		getTransport()
			.request("settings.update", { config: { fileSaveMode } })
			.catch((err: unknown) => toast.error(errorText(err), t("settings.fileSaveMode.failure")));
	};
	return <FileSaveModeSwitch protocolVersion={protocolVersion} mode={mode} onSelect={select} />;
}
