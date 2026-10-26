import type { EditConflict } from "../registry";

export interface ConflictSpan {
	startLine: number;
	endLine: number | null;
	theirsText: string;
}

interface SpanModel {
	getPositionAt(offset: number): { lineNumber: number; column: number };
	getValueLength(): number;
	getLineMaxColumn(lineNumber: number): number;
}

function startsAfterBreak(model: SpanModel, conflict: EditConflict): boolean {
	const start = model.getPositionAt(conflict.from);
	if (conflict.to === conflict.from) return start.column > 1;
	return (
		conflict.to === model.getValueLength() &&
		model.getPositionAt(conflict.to).column > 1 &&
		start.column === model.getLineMaxColumn(start.lineNumber) &&
		conflict.to > conflict.from + 1
	);
}

export function conflictSpan(model: SpanModel, conflict: EditConflict): ConflictSpan {
	const startLine = model.getPositionAt(conflict.from).lineNumber;
	const afterBreak = startsAfterBreak(model, conflict);
	const theirs =
		afterBreak && conflict.theirs.startsWith("\n") ? conflict.theirs.slice(1) : conflict.theirs;
	return {
		startLine: afterBreak ? startLine + 1 : startLine,
		endLine: conflict.to > conflict.from ? model.getPositionAt(conflict.to - 1).lineNumber : null,
		theirsText: theirs.endsWith("\n") ? theirs.slice(0, -1) : theirs,
	};
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
			match.span.theirsText === entry.theirsText &&
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
