import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import {
	CONFLICT_CHOICE_LABELS,
	CONFLICT_CHOICES,
	type ConflictChoice,
	type EditConflict,
} from "../registry";

export function ConflictLens({
	conflict,
	focusable,
	onResolve,
}: {
	conflict: EditConflict;
	focusable: boolean;
	onResolve(id: number, choice: ConflictChoice): void;
}) {
	const t = useT();
	return (
		<div
			data-testid="edit-conflict-lens"
			className="edit-conflict-lens flex h-full items-center gap-8 bg-feedback-warning-subtle px-8 tr-text-metadata text-text-default"
		>
			<span className="min-w-0 truncate">{t("panels.editConflict.title")}</span>
			{CONFLICT_CHOICES.map((choice) => (
				<Button
					key={choice}
					size="sm"
					variant="outline"
					{...(focusable ? {} : { tabIndex: -1 })}
					data-testid={`edit-conflict-${choice}`}
					onClick={() => onResolve(conflict.id, choice)}
				>
					{t(CONFLICT_CHOICE_LABELS[choice])}
				</Button>
			))}
		</div>
	);
}

export function ConflictTheirs({
	conflict,
	theirsText,
}: {
	conflict: EditConflict;
	theirsText: string;
}) {
	const t = useT();
	return (
		<div
			data-testid="edit-conflict-disk"
			className="edit-conflict-theirs h-full bg-feedback-warning-subtle text-text-muted"
		>
			{conflict.theirs === "" ? (
				<div className="edit-conflict-theirs-text tr-code-text-small italic">
					{t("panels.editConflict.deletedOnDisk")}
				</div>
			) : (
				<pre className="edit-conflict-theirs-text tr-code-text-small">{theirsText}</pre>
			)}
		</div>
	);
}
