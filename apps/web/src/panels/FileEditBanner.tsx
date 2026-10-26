import { RiAlertLine as Alert } from "@remixicon/react";
import { FILE_WRITE_MAX_BYTES } from "@thinkrail/contracts";
import type { MessageKey } from "@thinkrail/locales";
import { useT } from "@thinkrail/locales/react";
import {
	CONFLICT_CHOICE_LABELS,
	CONFLICT_CHOICES,
	type ConflictChoice,
} from "@thinkrail/resource-renderers";
import { Button } from "@thinkrail/ui/button";
import { hasPlatformModifier, platformShortcutLabel } from "../lib";
import type { FileBufferSummary } from "../store";

const MEBIBYTE = 1024 * 1024;

type HistoryCommand = "undo" | "redo";

function typedZ(event: Pick<KeyboardEvent, "key" | "code">): boolean {
	return /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() === "z" : event.code === "KeyZ";
}

export function historyCommand(
	event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
	platform?: string,
): HistoryCommand | null {
	if (event.altKey || !hasPlatformModifier(event, platform) || !typedZ(event)) return null;
	return event.shiftKey ? "redo" : "undo";
}

function listenForMenuHistory(
	node: HTMLElement | null,
	onHistory: (command: HistoryCommand) => void,
) {
	if (!node) return;
	const onBeforeInput = (event: InputEvent) => {
		if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") return;
		event.preventDefault();
		onHistory(event.inputType === "historyUndo" ? "undo" : "redo");
	};
	node.addEventListener("beforeinput", onBeforeInput);
	return () => node.removeEventListener("beforeinput", onBeforeInput);
}

function bannerMessage(summary: FileBufferSummary, autosave: boolean): MessageKey | null {
	switch (summary.status) {
		case "stale":
			return "panels.fileEdit.conflict";
		case "conflict":
			return "panels.fileEdit.paused";
		case "deleted":
			return "panels.fileEdit.deleted";
		case "readonly":
			return "panels.fileEdit.readonly";
		case "error":
			if (summary.error === "tooLarge") return "panels.fileEdit.tooLarge";
			if (summary.error === "notEditable") return "panels.fileEdit.notEditable";
			if (summary.error === "offline")
				return autosave ? "panels.fileEdit.offlineAuto" : "panels.fileEdit.offline";
			return "panels.fileEdit.failed";
		default:
			return null;
	}
}

export function FileEditBanner({
	summary,
	autosave,
	onReload,
	onKeepMine,
	onResolveFirst,
	onHistory,
}: {
	summary: FileBufferSummary | undefined;
	autosave: boolean;
	onReload(): void;
	onKeepMine(): void;
	onResolveFirst(choice: ConflictChoice): void;
	onHistory(command: HistoryCommand): void;
}) {
	const t = useT();
	const message = summary ? bannerMessage(summary, autosave) : null;
	const text = message
		? t(message, {
				shortcut: platformShortcutLabel("S"),
				limit: FILE_WRITE_MAX_BYTES / MEBIBYTE,
				count: summary?.conflicts ?? 0,
			})
		: summary?.status === "dirty" && summary.merges
			? t("panels.fileEdit.merged")
			: "";
	const urgent =
		summary?.status === "stale" || summary?.status === "conflict" || summary?.status === "error";
	return (
		<>
			<span role="status" aria-live={urgent ? "assertive" : "polite"} className="sr-only">
				<span key={summary?.merges ?? 0}>{text}</span>
			</span>
			{summary && message ? (
				<div
					data-testid="file-edit-banner"
					data-status={summary.status}
					className="flex shrink-0 items-center gap-8 border-border-default border-b bg-feedback-warning-subtle px-12 py-4 tr-text-metadata text-text-default"
				>
					<Alert className="size-14 shrink-0 text-feedback-warning" aria-hidden />
					<span className="min-w-0 flex-1" aria-hidden>
						{text}
					</span>
					{summary.status === "stale" ? (
						<>
							<Button
								size="sm"
								variant="outline"
								data-testid="file-edit-keep-mine"
								onClick={onKeepMine}
							>
								{t("panels.fileEdit.keepMine")}
							</Button>
							<Button size="sm" data-testid="file-edit-reload" onClick={onReload}>
								{t("panels.fileEdit.reload")}
							</Button>
						</>
					) : null}
					{summary.status === "conflict" ? (
						<fieldset
							ref={(node) => listenForMenuHistory(node, onHistory)}
							aria-label={t("panels.fileEdit.firstConflict")}
							className="flex shrink-0 items-center gap-8"
							onKeyDown={(event) => {
								const command = historyCommand(event);
								if (!command) return;
								event.preventDefault();
								onHistory(command);
							}}
						>
							{CONFLICT_CHOICES.map((choice) => (
								<Button
									key={choice}
									size="sm"
									variant="outline"
									data-testid={`file-edit-resolve-${choice}`}
									onClick={() => onResolveFirst(choice)}
								>
									{t(CONFLICT_CHOICE_LABELS[choice])}
								</Button>
							))}
						</fieldset>
					) : null}
				</div>
			) : null}
		</>
	);
}
