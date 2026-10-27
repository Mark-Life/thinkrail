import { createPortal } from "react-dom";
import type { ConflictChoice } from "../registry";
import { ConflictLens, ConflictTheirs } from "./conflictLens";
import type { ConflictZone } from "./conflictWidgets";

export function MonacoConflictZones({
	zones,
	onResolve,
}: {
	zones: readonly ConflictZone[];
	onResolve(id: number, choice: ConflictChoice): void;
}) {
	return zones.map(({ conflict, lens, theirs, theirsText }) => [
		createPortal(
			<ConflictLens conflict={conflict} focusable={false} onResolve={onResolve} />,
			lens,
			`lens:${conflict.id}`,
		),
		createPortal(
			<ConflictTheirs conflict={conflict} theirsText={theirsText} />,
			theirs,
			`theirs:${conflict.id}`,
		),
	]);
}
