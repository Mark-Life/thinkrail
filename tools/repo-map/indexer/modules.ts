import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { FileInfo, ModuleEdge, ModuleInfo } from "../core/types";

export function createModuleLocator(paths: readonly string[]) {
	const specDirs = new Set<string>();
	const packageDirs = new Set<string>();
	for (const path of paths) {
		const name = posix.basename(path);
		if (name === "SPEC.md") specDirs.add(posix.dirname(path));
		if (name === "package.json" && posix.dirname(path) !== ".") {
			packageDirs.add(posix.dirname(path));
		}
	}
	const nearest = (path: string, dirs: ReadonlySet<string>) => {
		let dir = posix.dirname(path);
		while (dir !== ".") {
			if (dirs.has(dir)) return dir;
			dir = posix.dirname(dir);
		}
		return undefined;
	};
	return {
		moduleOf: (path: string) => nearest(path, specDirs) ?? nearest(path, packageDirs) ?? ".",
		packageOf: (path: string) => nearest(path, packageDirs) ?? ".",
	};
}

function readSpec(root: string, modulePath: string) {
	const path = join(root, modulePath, "SPEC.md");
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

export function parseSpec(text: string) {
	const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
	const title = /^title:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
	const section = /^## Responsibility\s*\n+([\s\S]*?)(?:\n#|(?![\s\S]))/m.exec(text)?.[1] ?? "";
	const paragraph =
		section
			.split(/\n\s*\n/)[0]
			?.replace(/\s+/g, " ")
			.trim() ?? "";
	const responsibility = /^.*?[.!?](?=\s|$)/.exec(paragraph)?.[0] ?? paragraph;
	return {
		...(title ? { title } : {}),
		...(responsibility ? { responsibility } : {}),
	};
}

export function buildModules(input: { root: string; files: readonly FileInfo[] }) {
	const totals = new Map<string, { lines: number; files: number }>();
	for (const file of input.files) {
		const total = totals.get(file.module) ?? { lines: 0, files: 0 };
		total.lines += file.lines;
		total.files += 1;
		totals.set(file.module, total);
	}
	const modules: ModuleInfo[] = [...totals]
		.map(([path, total]) => {
			const spec = readSpec(input.root, path);
			return { path, ...total, ...(spec ? parseSpec(spec) : {}) };
		})
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return modules;
}

export function buildModuleEdges(files: readonly FileInfo[]) {
	const moduleOfFile = new Map(files.map((file) => [file.path, file.module]));
	const counts = new Map<string, ModuleEdge>();
	for (const file of files) {
		for (const target of file.imports) {
			const to = moduleOfFile.get(target);
			if (!to || to === file.module) continue;
			const key = `${file.module}\0${to}`;
			const edge = counts.get(key) ?? { from: file.module, to, imports: 0 };
			edge.imports += 1;
			counts.set(key, edge);
		}
	}
	return [...counts.values()].sort(
		(a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
	);
}
