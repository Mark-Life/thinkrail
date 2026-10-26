import type { EditConflict } from "../registry";

export interface ConflictSpan {
	startLine: number;
	endLine: number | null;
}

export function planConflictZones<Entry extends ConflictSpan & { conflict: EditConflict }>(
	placed: readonly Entry[],
	next: readonly { conflict: EditConflict; span: ConflictSpan }[],
) {
	const kept = new Map<number, Entry>();
	const removed: Entry[] = [];
	for (const entry of placed) {
		const match = next.find(({ conflict }) => conflict.id === entry.conflict.id);
		if (
			match &&
			match.conflict.theirs === entry.conflict.theirs &&
			match.span.startLine === entry.startLine &&
			match.span.endLine === entry.endLine
		) {
			kept.set(entry.conflict.id, { ...entry, conflict: match.conflict });
		} else {
			removed.push(entry);
		}
	}
	const unchanged =
		removed.length === 0 &&
		placed.length === next.length &&
		next.every(({ conflict }, index) => placed[index]?.conflict.id === conflict.id);
	return { kept, removed, unchanged };
}
