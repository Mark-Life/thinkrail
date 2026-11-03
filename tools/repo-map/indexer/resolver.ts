import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import ts from "typescript";

interface WorkspacePackage {
	name: string;
	dir: string;
	manifest: Manifest;
}

interface Manifest {
	name?: unknown;
	exports?: unknown;
	main?: unknown;
	module?: unknown;
	types?: unknown;
}

interface PathRule {
	pattern: string;
	targets: string[];
}

interface PathMapping {
	dir: string;
	rules: PathRule[];
}

export interface WorkspaceIndex {
	root: string;
	packages: WorkspacePackage[];
	mappings: Map<string, PathMapping>;
}

const CONDITION_ORDER = ["types", "bun", "import", "module", "default", "node", "require"];

function readManifest(path: string): Manifest {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathRulesOf(config: unknown): PathRule[] | undefined {
	if (!isRecord(config) || !isRecord(config.compilerOptions)) return undefined;
	const paths = config.compilerOptions.paths;
	if (!isRecord(paths)) return undefined;
	return Object.entries(paths).map(([pattern, targets]) => ({
		pattern,
		targets: Array.isArray(targets)
			? targets.filter((target): target is string => typeof target === "string")
			: [],
	}));
}

function loadPathMapping(root: string, configPath: string, depth = 0): PathMapping | undefined {
	if (depth > 8) return undefined;
	const absolute = join(root, configPath);
	const { config } = ts.readConfigFile(absolute, (path) => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	});
	const rules = pathRulesOf(config);
	if (rules) {
		const baseUrl =
			isRecord(config) &&
			isRecord(config.compilerOptions) &&
			typeof config.compilerOptions.baseUrl === "string"
				? config.compilerOptions.baseUrl
				: ".";
		return { dir: join(dirname(absolute), baseUrl), rules };
	}
	const parent = isRecord(config) ? config.extends : undefined;
	if (typeof parent !== "string" || !parent.startsWith(".")) return undefined;
	const parentPath = posix.normalize(posix.join(posix.dirname(configPath), parent));
	if (parentPath.startsWith("..")) return undefined;
	return loadPathMapping(root, parentPath, depth + 1);
}

export function buildWorkspaceIndex(input: { root: string; paths: readonly string[] }) {
	const manifests = input.paths
		.filter((path) => posix.basename(path) === "package.json")
		.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
	const packages: WorkspacePackage[] = [];
	for (const path of manifests) {
		const manifest = readManifest(join(input.root, path));
		if (typeof manifest.name !== "string") continue;
		if (packages.some((known) => known.name === manifest.name)) continue;
		packages.push({
			name: manifest.name,
			dir: join(input.root, posix.dirname(path)),
			manifest,
		});
	}
	const mappings = new Map<string, PathMapping>();
	const configs = input.paths
		.filter((path) => /^tsconfig.*\.json$/.test(posix.basename(path)))
		.sort((a, b) => a.length - b.length || a.localeCompare(b));
	for (const path of configs) {
		const key = join(input.root, posix.dirname(path));
		if (mappings.has(key)) continue;
		const mapping = loadPathMapping(input.root, path);
		if (mapping) mappings.set(key, mapping);
	}
	const index: WorkspaceIndex = { root: input.root, packages, mappings };
	return index;
}

function conditionTargets(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(conditionTargets);
	if (!isRecord(value)) return [];
	const known = CONDITION_ORDER.filter((condition) => condition in value);
	return known.flatMap((condition) => conditionTargets(value[condition]));
}

function exportTargets(exportsField: unknown, subpath: string): string[] {
	if (!isRecord(exportsField)) return subpath === "." ? conditionTargets(exportsField) : [];
	const hasSubpaths = Object.keys(exportsField).some((key) => key.startsWith("."));
	if (!hasSubpaths) return subpath === "." ? conditionTargets(exportsField) : [];
	const exact = exportsField[subpath];
	if (exact !== undefined) return conditionTargets(exact);
	for (const [key, value] of Object.entries(exportsField)) {
		const star = key.indexOf("*");
		if (star < 0) continue;
		const prefix = key.slice(0, star);
		const suffix = key.slice(star + 1);
		if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
		const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
		return conditionTargets(value).map((target) => target.replaceAll("*", matched));
	}
	return [];
}

function packageTargets(pkg: WorkspacePackage, subpath: string) {
	const { manifest } = pkg;
	if (manifest.exports !== undefined) return exportTargets(manifest.exports, subpath);
	if (subpath !== ".") return [subpath];
	const declared = [manifest.types, manifest.module, manifest.main].filter(
		(entry): entry is string => typeof entry === "string",
	);
	return [...declared, "./index", "./src/index"];
}

export function packageEntryFiles(index: WorkspaceIndex) {
	const entries = new Set<string>();
	for (const pkg of index.packages) {
		if (!isRecord(pkg.manifest.exports)) continue;
		for (const value of Object.values(pkg.manifest.exports)) {
			for (const target of conditionTargets(value)) {
				if (target.includes("*")) continue;
				entries.add(join(pkg.dir, target));
			}
		}
	}
	return entries;
}

function matchWorkspace(index: WorkspaceIndex, specifier: string) {
	for (const pkg of index.packages) {
		if (specifier === pkg.name) return { pkg, subpath: "." };
		if (specifier.startsWith(`${pkg.name}/`)) {
			return { pkg, subpath: `./${specifier.slice(pkg.name.length + 1)}` };
		}
	}
	return undefined;
}

export function isWorkspaceImport(index: WorkspaceIndex, specifier: string) {
	return matchWorkspace(index, specifier) !== undefined;
}

function nearestMapping(index: WorkspaceIndex, containingFile: string) {
	let dir = dirname(containingFile);
	while (dir.length >= index.root.length) {
		const mapping = index.mappings.get(dir);
		if (mapping) return mapping;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

function mappedTargets(mapping: PathMapping, specifier: string) {
	for (const { pattern, targets } of mapping.rules) {
		const star = pattern.indexOf("*");
		if (star < 0) {
			if (pattern === specifier) return targets.map((target) => join(mapping.dir, target));
			continue;
		}
		const prefix = pattern.slice(0, star);
		const suffix = pattern.slice(star + 1);
		if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
		const matched = specifier.slice(prefix.length, specifier.length - suffix.length);
		return targets.map((target) => join(mapping.dir, target.replaceAll("*", matched)));
	}
	return [];
}

export function createModuleResolver(input: {
	index: WorkspaceIndex;
	options: ts.CompilerOptions;
	host: ts.ModuleResolutionHost;
}) {
	const { index, options, host } = input;
	const cache = ts.createModuleResolutionCache(index.root, (name) => name, options);
	const insideOrExternal = (resolved: ts.ResolvedModuleFull | undefined) => {
		if (!resolved) return undefined;
		const { resolvedFileName } = resolved;
		const safe =
			resolvedFileName.startsWith(index.root) || resolvedFileName.includes("/node_modules/");
		return safe ? resolved : undefined;
	};
	const resolveDefault = (specifier: string, containingFile: string) =>
		insideOrExternal(
			ts.resolveModuleName(specifier, containingFile, options, host, cache).resolvedModule,
		);
	const resolveFirst = (targets: readonly string[], containingFile: string) => {
		for (const target of targets) {
			const resolved = resolveDefault(target, containingFile);
			if (resolved) return resolved;
		}
		return undefined;
	};
	return (specifier: string, containingFile: string) => {
		if (specifier.startsWith(".") || specifier.startsWith("/")) {
			return resolveDefault(specifier, containingFile);
		}
		const mapping = nearestMapping(index, containingFile);
		if (mapping) {
			const mapped = resolveFirst(mappedTargets(mapping, specifier), containingFile);
			if (mapped) return mapped;
		}
		const workspace = matchWorkspace(index, specifier);
		if (workspace) {
			const targets = packageTargets(workspace.pkg, workspace.subpath).map((target) =>
				join(workspace.pkg.dir, target),
			);
			return resolveFirst(targets, containingFile);
		}
		return resolveDefault(specifier, containingFile);
	};
}
