export function clampWidth(input: { width: number; min: number; max: number }) {
	return Math.round(Math.max(input.min, Math.min(input.width, Math.max(input.min, input.max))));
}

export function parseStoredWidth(input: { stored: string | null; fallback: number }) {
	const parsed = Number(input.stored);
	return input.stored !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : input.fallback;
}

export interface HistoryPosition {
	position: number;
	last: number;
}

export function readEntryPosition(state: unknown) {
	if (typeof state !== "object" || state === null || !("repoMapPosition" in state)) {
		return undefined;
	}
	return typeof state.repoMapPosition === "number" ? state.repoMapPosition : undefined;
}

export function nextHistoryPosition(input: {
	current: HistoryPosition;
	entry: number | undefined;
}): HistoryPosition {
	const { current, entry } = input;
	if (entry !== undefined) return { position: entry, last: Math.max(current.last, entry) };
	const position = current.position + 1;
	return { position, last: position };
}
