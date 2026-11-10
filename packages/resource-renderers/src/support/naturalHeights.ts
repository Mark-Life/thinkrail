interface NaturalHeight {
	height: number;
	stamp: string;
}

export const NATURAL_HEIGHT_LIMIT = 500;

const heights = new Map<string, NaturalHeight>();

export function naturalHeightKey(workspaceId: string, path: string, before?: string): string {
	return [workspaceId, path, before ?? ""].join("\u0000");
}

export function rememberedNaturalHeight(key: string, stamp?: string): number | undefined {
	const remembered = heights.get(key);
	if (!remembered || (stamp !== undefined && remembered.stamp !== stamp)) return undefined;
	return remembered.height;
}

export function rememberNaturalHeight(key: string, stamp: string, height: number): void {
	heights.delete(key);
	const oldest = heights.size >= NATURAL_HEIGHT_LIMIT ? heights.keys().next().value : undefined;
	if (oldest !== undefined) heights.delete(oldest);
	heights.set(key, { height, stamp });
}

export function forgetNaturalHeight(key: string): void {
	heights.delete(key);
}
