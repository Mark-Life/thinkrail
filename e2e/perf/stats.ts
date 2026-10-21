export function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[middle] ?? 0)
		: ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function spreadPct(values: readonly number[]): number {
	const middle = median(values);
	if (values.length === 0 || middle === 0) return 0;
	return ((Math.max(...values) - Math.min(...values)) / middle) * 100;
}
