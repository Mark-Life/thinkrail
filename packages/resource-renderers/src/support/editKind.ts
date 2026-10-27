import type { LocalEditKind, TextChange } from "../registry";

export type Composition = "idle" | "start" | "active";

export function classifyEdit(
	changes: readonly TextChange[],
	{ composition, paste, typing }: { composition: Composition; paste: boolean; typing: boolean },
): LocalEditKind {
	if (composition === "start") return "composeStart";
	if (composition === "active") return "compose";
	if (paste) return "paste";
	if (changes.every((change) => change.insert === "")) return "delete";
	const typed =
		typing &&
		changes.every(
			(change) =>
				change.insert !== "" &&
				!change.insert.includes("\n") &&
				(change.to === change.from || change.insert.length === 1),
		);
	return typed ? "type" : "other";
}
