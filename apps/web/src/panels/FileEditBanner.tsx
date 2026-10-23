import { RiAlertLine as Alert } from "@remixicon/react";
import type { MessageKey } from "@thinkrail/locales";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { platformShortcutLabel } from "../lib";
import type { FileBufferSummary } from "../store";

function bannerMessage(summary: FileBufferSummary): MessageKey | null {
	switch (summary.status) {
		case "stale":
			return "panels.fileEdit.conflict";
		case "deleted":
			return "panels.fileEdit.deleted";
		case "readonly":
			return "panels.fileEdit.readonly";
		case "error":
			if (summary.error === "tooLarge") return "panels.fileEdit.tooLarge";
			if (summary.error === "notEditable") return "panels.fileEdit.notEditable";
			return "panels.fileEdit.failed";
		default:
			return null;
	}
}

export function FileEditBanner({
	summary,
	onReload,
	onKeepMine,
}: {
	summary: FileBufferSummary | undefined;
	onReload(): void;
	onKeepMine(): void;
}) {
	const t = useT();
	const message = summary ? bannerMessage(summary) : null;
	const text = message ? t(message, { shortcut: platformShortcutLabel("S") }) : "";
	const urgent = summary?.status === "stale" || summary?.status === "error";
	return (
		<>
			<span role="status" aria-live={urgent ? "assertive" : "polite"} className="sr-only">
				{text}
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
				</div>
			) : null}
		</>
	);
}
