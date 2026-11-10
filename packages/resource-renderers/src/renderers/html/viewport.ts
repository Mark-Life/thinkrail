export const HTML_CONTENT_HEIGHT = { min: 120, max: 1600 } as const;

export function clampContentHeight(height: number): number {
	if (!Number.isFinite(height)) return HTML_CONTENT_HEIGHT.min;
	return Math.min(HTML_CONTENT_HEIGHT.max, Math.max(HTML_CONTENT_HEIGHT.min, Math.ceil(height)));
}
