import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { createPortal } from "react-dom";
import type { ConflictChoice } from "../registry";
import type { ConflictZone } from "./conflictWidgets";

const CHOICES: readonly ConflictChoice[] = ["mine", "theirs", "both"];

function theirsText(theirs: string): string {
	return theirs.endsWith("\n") ? theirs.slice(0, -1) : theirs;
}

export function MonacoConflictZones({
	zones,
	onResolve,
}: {
	zones: readonly ConflictZone[];
	onResolve(id: number, choice: ConflictChoice): void;
}) {
	const t = useT();
	const label = {
		mine: t("panels.editConflict.mine"),
		theirs: t("panels.editConflict.theirs"),
		both: t("panels.editConflict.both"),
	} satisfies Record<ConflictChoice, string>;
	return zones.map(({ conflict, lens, theirs }) => [
		createPortal(
			<div
				data-testid="edit-conflict-lens"
				className="edit-conflict-lens flex h-full items-center gap-8 bg-feedback-warning-subtle px-8 tr-text-metadata text-text-default"
			>
				<span className="min-w-0 truncate">{t("panels.editConflict.title")}</span>
				{CHOICES.map((choice) => (
					<Button
						key={choice}
						size="sm"
						variant="outline"
						data-testid={`edit-conflict-${choice}`}
						onClick={() => onResolve(conflict.id, choice)}
					>
						{label[choice]}
					</Button>
				))}
			</div>,
			lens,
			`lens:${conflict.id}`,
		),
		createPortal(
			<div
				data-testid="edit-conflict-disk"
				className="edit-conflict-theirs h-full bg-feedback-warning-subtle text-text-muted"
			>
				{conflict.theirs === "" ? (
					<div className="edit-conflict-theirs-text tr-code-text-small italic">
						{t("panels.editConflict.deletedOnDisk")}
					</div>
				) : (
					<pre className="edit-conflict-theirs-text tr-code-text-small">
						{theirsText(conflict.theirs)}
					</pre>
				)}
			</div>,
			theirs,
			`theirs:${conflict.id}`,
		),
	]);
}
