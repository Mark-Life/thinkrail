import type { RepoGraph } from "../../core/types";

const PACKAGE_SLOTS = 8;

function packageOf(modulePath: string) {
	const [first = ".", second] = modulePath.split("/");
	if ((first === "apps" || first === "packages") && second) return `${first}/${second}`;
	return first;
}

export interface PackageColors {
	slotOf: (modulePath: string) => number | undefined;
	legend: { name: string; slot: number; lines: number }[];
}

export function buildPackageColors(graph: Pick<RepoGraph, "files">): PackageColors {
	const lines = new Map<string, number>();
	for (const file of graph.files) {
		const name = packageOf(file.module);
		lines.set(name, (lines.get(name) ?? 0) + file.lines);
	}
	const ranked = [...lines]
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.slice(0, PACKAGE_SLOTS);
	const slots = new Map(ranked.map(([name], slot) => [name, slot]));
	return {
		slotOf: (modulePath) => slots.get(packageOf(modulePath)),
		legend: ranked.map(([name, total], slot) => ({ name, slot, lines: total })),
	};
}
