import type { MessageKey } from "@thinkrail/locales";
import type { ConflictChoice } from "./types";

export const CONFLICT_CHOICES: readonly ConflictChoice[] = ["mine", "theirs", "both"];

export const CONFLICT_CHOICE_LABELS = {
	mine: "panels.editConflict.mine",
	theirs: "panels.editConflict.theirs",
	both: "panels.editConflict.both",
} as const satisfies Record<ConflictChoice, MessageKey>;
