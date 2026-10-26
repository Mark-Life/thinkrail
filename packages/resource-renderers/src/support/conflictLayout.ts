import type { EditConflict } from "../registry";

export interface ConflictSpan {
	startLine: number;
	endLine: number | null;
}

export function sameConflictLayout(
	placed: readonly (ConflictSpan & { conflict: EditConflict })[],
	next: readonly { conflict: EditConflict; span: ConflictSpan }[],
): boolean {
	return (
		placed.length === next.length &&
		next.every(({ conflict, span }, index) => {
			const entry = placed[index];
			return (
				entry !== undefined &&
				entry.conflict.id === conflict.id &&
				entry.conflict.theirs === conflict.theirs &&
				entry.startLine === span.startLine &&
				entry.endLine === span.endLine
			);
		})
	);
}
