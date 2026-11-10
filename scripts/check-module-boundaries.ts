#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { compile, map, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { type Argument, parseSync, Visitor } from "oxc-parser";

const DependencyMap = opt(map(str()));
const Manifest = compile(
	obj(
		{
			name: opt(str()),
			exports: opt(map(unknown())),
			dependencies: DependencyMap,
			devDependencies: DependencyMap,
			optionalDependencies: DependencyMap,
			peerDependencies: DependencyMap,
		},
		{ open: true },
	),
);

function readManifest(path: string) {
	const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!Manifest.check(manifest)) {
		const problems = Manifest.errors(manifest).map((error) => `${error.path} ${error.message}`);
		throw new Error(`invalid ${path}: ${problems.join("; ")}`);
	}
	return manifest;
}

interface ModuleRule {
	root: string;
	allowed: readonly string[];
}

const PI_PACKAGE = /^(?:@[^/]+\/)?pi-[^/]+(?:\/|$)/;
const PI_SCHEMA = /^@earendil-works\/pi-schema(?:\/|$)/;
const MODEL_SCHEMA = "@earendil-works/pi-ai/providers/model-schema";
const PI_TYPE_ROOTS: ReadonlySet<string> = new Set([
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
]);
const PI_VALUE_IMPORT = "creates forbidden pi value import in browser-safe sources";
const PI_TYPE_IMPORT =
	"creates forbidden pi import in browser-safe sources: types come only from the pi-ai and pi-agent-core roots or a leaf entry";

/**
 * The entries of pi packages that browser code may load. A leaf is itself checked as a browser-safe
 * source; a `type` leaf is only ever loaded for its types, so its own value imports never reach a bundle.
 */
interface LeafEntry {
	specifier: string;
	mode: "value" | "type";
	/** The only modules that may import it; any browser-safe source when absent. */
	importers?: readonly string[];
}

const LEAF_ENTRIES: readonly LeafEntry[] = [
	{ specifier: "pi-todos/wire", mode: "value" },
	{ specifier: "pi-background-commands/wire", mode: "value" },
	{ specifier: "pi-delegation/wire", mode: "value" },
	{ specifier: "pi-subagents/wire", mode: "value" },
	{
		specifier: "@thinkrail/pi-ask-user-question/core",
		mode: "value",
		importers: ["thinkrail-extensions/ask-user-question", "packages/contracts"],
	},
	{
		specifier: "@thinkrail/pi-visualize/schema",
		mode: "type",
		importers: ["thinkrail-extensions/visualize"],
	},
];

/** Packages a module may reach only through one leaf entry of the owner, by package root. */
const LEAF_ONLY_TARGETS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	"packages/contracts": {
		"packages/pi-todos": "wire",
		"packages/pi-background-commands": "wire",
		"packages/pi-delegation": "wire",
		"packages/pi-subagents": "wire",
		"pi-extensions/ask-user-question": "core",
	},
	"packages/pi-subagents": { "packages/pi-background-commands": "wire" },
};

const TEST_IDS_ENTRY = /^(?:test-ids|src\/testIds(?:\.ts)?)$/;
const ID_SOURCE = /^src\/schema\/ids(?:\.ts)?$/;
const TEST_SOURCE =
	/\.(?:test|spec|perf|fixture)\.[cm]?[jt]sx?$|(?:^|\/)(?:testing|fixtures)\/|(?:^|\/)(?:test[A-Z-]|fixtures\.)[^/]*$/;

const MODULE_RULES: readonly ModuleRule[] = [
	{
		root: "packages/artifact-tests",
		allowed: ["apps/cli", "packages/contracts", "packages/server", "packages/shared"],
	},
	{
		root: "packages/contracts",
		allowed: [
			"packages/pi-todos",
			"packages/pi-background-commands",
			"packages/pi-delegation",
			"packages/pi-subagents",
			"pi-extensions/ask-user-question",
			"packages/type-tie",
		],
	},
	{ root: "packages/shared", allowed: ["packages/contracts"] },
	{ root: "packages/type-tie", allowed: [] },
	{ root: "packages/pi-todos", allowed: [] },
	{ root: "packages/pi-delegation", allowed: ["packages/type-tie"] },
	{ root: "packages/pi-background-commands", allowed: [] },
	{
		root: "packages/pi-subagents",
		allowed: ["packages/pi-delegation", "packages/pi-background-commands"],
	},
	{ root: "packages/pi-dag", allowed: ["packages/pi-delegation", "packages/type-tie"] },
	{
		root: "packages/server",
		allowed: [
			"packages/contracts",
			"packages/locales",
			"packages/shared",
			"packages/spec-graph",
			"packages/pi-delegation",
			"packages/pi-background-commands",
			"packages/pi-subagents",
			"packages/pi-thinkrail-workflow",
			"packages/pi-todos",
			"packages/extension-api",
		],
	},
	{
		root: "apps/web",
		allowed: [
			"packages/contracts",
			"packages/locales",
			"packages/ui",
			"packages/extension-api",
			"packages/resource-renderers",
		],
	},
	{ root: "apps/cli", allowed: ["packages/server", "packages/shared"] },
	{
		root: "apps/desktop",
		allowed: ["packages/server", "packages/shared", "packages/contracts", "packages/locales"],
	},
];

const DEPENDENCY_SECTIONS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const EXCLUDED_DIRECTORIES = new Set([
	".git",
	".hutch",
	".cottontail-tmp",
	".stage",
	"artifacts",
	"build",
	"dist",
	"node_modules",
]);

function normalized(path: string): string {
	return path.split(sep).join("/");
}

function workspacePackages(root: string): Map<string, string> {
	const packages = new Map<string, string>();
	for (const base of ["apps", "packages", "pi-extensions", "thinkrail-extensions"]) {
		const basePath = join(root, base);
		if (!existsSync(basePath)) continue;
		for (const entry of readdirSync(basePath, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const moduleRoot = `${base}/${entry.name}`;
			const manifestPath = join(root, moduleRoot, "package.json");
			if (!existsSync(manifestPath)) continue;
			const manifest = readManifest(manifestPath);
			if (manifest.name) packages.set(manifest.name, moduleRoot);
		}
	}
	return packages;
}

function moduleRules(packages: ReadonlyMap<string, string>): ModuleRule[] {
	const roots = [...packages.values()];
	const extensions = roots.filter((root) => root.startsWith("thinkrail-extensions/"));
	return [
		...MODULE_RULES.map((rule) =>
			rule.root === "apps/web" || rule.root === "packages/server"
				? { ...rule, allowed: [...rule.allowed, ...extensions] }
				: rule,
		),
		...roots
			.filter((root) => root === "packages/ui" || root === "packages/extension-api")
			.map((root) => ({
				root,
				allowed: ["packages/contracts", "packages/locales"],
			})),
		...roots.filter((root) => root === "packages/locales").map((root) => ({ root, allowed: [] })),
		...roots
			.filter((root) => root === "packages/resource-renderers")
			.map((root) => ({
				root,
				allowed: ["packages/contracts", "packages/locales", "packages/ui"],
			})),
		...roots
			.filter((root) => root.startsWith("pi-extensions/"))
			.map((root) => ({ root, allowed: [] })),
		...extensions.map((root) => ({
			root,
			allowed: [
				"packages/contracts",
				"packages/locales",
				"packages/ui",
				"packages/extension-api",
				"packages/resource-renderers",
				piExtensionRoot(root),
			],
		})),
	];
}

function piExtensionRoot(extensionRoot: string): string {
	return extensionRoot.replace(/^thinkrail-extensions\//, "pi-extensions/");
}

function sourceFiles(root: string): string[] {
	const files: string[] = [];
	const visit = (path: string): void => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
			const child = join(path, entry.name);
			if (entry.isDirectory()) visit(child);
			else if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf("."))))
				files.push(child);
		}
	};
	visit(root);
	return files;
}

interface SourceImport {
	specifier: string;
	typeOnly: boolean;
}

function stringLiteralValue(node: Argument | null | undefined): string | undefined {
	if (node?.type === "Literal" && typeof node.value === "string") return node.value;
	if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
		return node.quasis[0]?.value.cooked ?? undefined;
	}
	return undefined;
}

function parseLang(path: string) {
	if (path.endsWith(".tsx")) return "tsx";
	return /\.[mc]?ts$/.test(path) ? "ts" : "jsx";
}

function importSpecifiers(path: string, file: string): SourceImport[] {
	const { program, errors } = parseSync(path, readFileSync(path, "utf8"), {
		lang: parseLang(path),
		...(/\.c[jt]s$/.test(path) ? { sourceType: "commonjs" as const } : {}),
	});
	if (errors.length > 0) {
		throw new Error(`cannot parse ${file}: ${errors.map((error) => error.message).join("; ")}`);
	}
	const specifiers: SourceImport[] = [];
	const add = (node: Argument | null | undefined, typeOnly = false): void => {
		const specifier = stringLiteralValue(node);
		if (specifier !== undefined) specifiers.push({ specifier, typeOnly });
	};
	new Visitor({
		ImportDeclaration(node) {
			add(
				node.source,
				node.importKind === "type" ||
					(node.specifiers.length > 0 &&
						node.specifiers.every(
							(specifier) =>
								specifier.type === "ImportSpecifier" && specifier.importKind === "type",
						)),
			);
		},
		ExportNamedDeclaration(node) {
			add(
				node.source,
				node.exportKind === "type" ||
					(node.specifiers.length > 0 &&
						node.specifiers.every((specifier) => specifier.exportKind === "type")),
			);
		},
		ExportAllDeclaration(node) {
			add(node.source, node.exportKind === "type");
		},
		TSImportEqualsDeclaration(node) {
			if (node.moduleReference.type === "TSExternalModuleReference") {
				add(node.moduleReference.expression, node.importKind === "type");
			}
		},
		ImportExpression(node) {
			add(node.source);
		},
		CallExpression(node) {
			if (node.callee.type === "Identifier" && node.callee.name === "require") {
				add(node.arguments[0]);
			}
		},
		TSImportType(node) {
			add(node.source, true);
		},
	}).visit(program);
	return specifiers;
}

interface WorkspaceTarget {
	root: string;
	name: string;
	subpath: string;
}

function workspaceTarget(
	specifier: string,
	fromFile: string,
	root: string,
	packages: ReadonlyMap<string, string>,
): WorkspaceTarget | undefined {
	if (specifier.startsWith(".")) {
		const target = resolve(dirname(fromFile), specifier);
		for (const [name, moduleRoot] of packages) {
			const modulePath = join(root, moduleRoot);
			if (target === modulePath || target.startsWith(`${modulePath}${sep}`)) {
				return { root: moduleRoot, name, subpath: normalized(relative(modulePath, target)) };
			}
		}
		return undefined;
	}
	for (const [name, moduleRoot] of packages) {
		if (specifier === name || specifier.startsWith(`${name}/`)) {
			const modulePath = join(root, moduleRoot);
			const target = resolve(modulePath, specifier.slice(name.length + 1));
			return { root: moduleRoot, name, subpath: normalized(relative(modulePath, target)) };
		}
	}
	return undefined;
}

function allowedEdge(rule: ModuleRule, target: string): boolean {
	return target === rule.root || rule.allowed.includes(target);
}

function sourceHalf(subpath: string): "web" | "server" | undefined {
	const half = /^(web|server)(?:\/|$|\.[cm]?[jt]sx?$)/.exec(subpath)?.[1];
	return half === "web" || half === "server" ? half : undefined;
}

function sourceRule(rule: ModuleRule, subpath: string): ModuleRule {
	if (!rule.root.startsWith("thinkrail-extensions/")) return rule;
	switch (sourceHalf(subpath)) {
		case "web":
			return {
				...rule,
				allowed: [
					"packages/contracts",
					"packages/locales",
					"packages/ui",
					"packages/extension-api",
					"packages/resource-renderers",
					piExtensionRoot(rule.root),
				],
			};
		case "server":
			return { ...rule, allowed: ["packages/extension-api", piExtensionRoot(rule.root)] };
		default:
			return rule;
	}
}

function idMakerViolation(rule: ModuleRule, subpath: string, target: WorkspaceTarget) {
	if (target.root !== "packages/contracts") return undefined;
	if (rule.root !== target.root && ID_SOURCE.test(target.subpath)) {
		return "reaches contracts' id source past its public entries";
	}
	if (
		TEST_IDS_ENTRY.test(target.subpath) &&
		rule.root !== "packages/artifact-tests" &&
		!TEST_SOURCE.test(subpath)
	) {
		return "uses the test-only id makers outside test sources";
	}
	return undefined;
}

function isPiImport(specifier: string, target: WorkspaceTarget | undefined): boolean {
	return (
		target?.root.startsWith("pi-extensions/") === true || PI_PACKAGE.test(target?.name ?? specifier)
	);
}

function leafFor(specifier: string): LeafEntry | undefined {
	return LEAF_ENTRIES.find((leaf) => leaf.specifier === specifier);
}

function browserPiViolation(
	rule: ModuleRule,
	{ specifier, typeOnly }: SourceImport,
	target: WorkspaceTarget | undefined,
	typesUnchecked: boolean,
): string | undefined {
	if (target?.root === rule.root && specifier.startsWith(".")) return undefined;
	if (!isPiImport(specifier, target) || PI_SCHEMA.test(specifier) || specifier === MODEL_SCHEMA)
		return undefined;
	if (typeOnly && (typesUnchecked || PI_TYPE_ROOTS.has(specifier))) return undefined;
	const leaf = leafFor(specifier);
	if (
		leaf &&
		(leaf.importers === undefined || leaf.importers.includes(rule.root)) &&
		(typeOnly || leaf.mode === "value")
	)
		return undefined;
	return typeOnly ? PI_TYPE_IMPORT : PI_VALUE_IMPORT;
}

function leafViolation(leaf: LeafEntry, { specifier, typeOnly }: SourceImport): string | undefined {
	if (leaf.mode === "type" || typeOnly) return undefined;
	if (specifier.startsWith(".")) return `value-imports a relative file from leaf ${leaf.specifier}`;
	if (
		PI_SCHEMA.test(specifier) ||
		specifier === MODEL_SCHEMA ||
		leafFor(specifier)?.mode === "value"
	)
		return undefined;
	return `is loaded by leaf ${leaf.specifier}, which may value-import only pi-schema, pi-ai's model-schema and value leaves`;
}

function sourceViolation(
	rule: ModuleRule,
	subpath: string,
	sourceImport: SourceImport,
	target: WorkspaceTarget | undefined,
	leaf: LeafEntry | undefined,
): string | undefined {
	const { specifier } = sourceImport;
	if (target && !allowedEdge(sourceRule(rule, subpath), target.root)) {
		return `creates forbidden ${rule.root} -> ${target.root} edge`;
	}
	const extension = rule.root.startsWith("thinkrail-extensions/");
	const half = sourceHalf(subpath);
	const sdk = rule.root === "packages/extension-api";
	const sdkHalf = sourceHalf(subpath.replace(/^src\//, ""));
	if (target) {
		const idMaker = idMakerViolation(rule, subpath, target);
		if (idMaker) return idMaker;
		if (extension && target.root === rule.root && half) {
			const targetHalf = sourceHalf(target.subpath);
			if (targetHalf && targetHalf !== half) return "crosses extension web/server source halves";
		}
		if (
			sdk &&
			sdkHalf !== "server" &&
			target.root === rule.root &&
			sourceHalf(target.subpath.replace(/^src\//, "")) === "server"
		) {
			return "leaks extension-api's server half into browser sources";
		}
		let publicEntry: string | undefined;
		if (target.root.startsWith("thinkrail-extensions/")) {
			if (rule.root === "apps/web") publicEntry = "web";
			if (rule.root === "packages/server") publicEntry = "server";
		} else if (target.root === "packages/extension-api" && !sdk) {
			if (rule.root === "apps/web" || (extension && half === "web")) publicEntry = "web";
			if (rule.root === "packages/server" || (extension && half === "server"))
				publicEntry = "server";
		} else {
			publicEntry = LEAF_ONLY_TARGETS[rule.root]?.[target.root];
		}
		if (publicEntry && specifier !== `${target.name}/${publicEntry}`) {
			return `may use only public ${target.name}/${publicEntry}`;
		}
	}
	const browserSafe =
		rule.root === "apps/web" ||
		rule.root === "packages/ui" ||
		rule.root === "packages/resource-renderers" ||
		rule.root === "packages/contracts" ||
		rule.root === "packages/locales" ||
		sdk ||
		(extension && half === "web") ||
		leaf !== undefined;
	if (browserSafe) {
		const piViolation = browserPiViolation(rule, sourceImport, target, sdk && sdkHalf === "server");
		if (piViolation) return piViolation;
	}
	return leaf ? leafViolation(leaf, sourceImport) : undefined;
}

/** The source file of each leaf entry whose package is in the workspace, by absolute path. */
function leafFiles(
	root: string,
	packages: ReadonlyMap<string, string>,
	violations: string[],
): Map<string, LeafEntry> {
	const files = new Map<string, LeafEntry>();
	for (const leaf of LEAF_ENTRIES) {
		for (const [name, moduleRoot] of packages) {
			if (!leaf.specifier.startsWith(`${name}/`)) continue;
			const entry = `./${leaf.specifier.slice(name.length + 1)}`;
			const file = readManifest(join(root, moduleRoot, "package.json")).exports?.[entry];
			if (typeof file === "string") files.set(resolve(root, moduleRoot, file), leaf);
			else
				violations.push(`${moduleRoot}/package.json: leaf entry ${leaf.specifier} is not exported`);
		}
	}
	return files;
}

export function moduleBoundaryViolations(root: string): string[] {
	const absoluteRoot = resolve(root);
	const packages = workspacePackages(absoluteRoot);
	const violations: string[] = [];
	const leaves = leafFiles(absoluteRoot, packages, violations);
	for (const rule of moduleRules(packages)) {
		const modulePath = join(absoluteRoot, rule.root);
		const manifestPath = join(modulePath, "package.json");
		if (!existsSync(manifestPath)) {
			violations.push(`${rule.root}/package.json is missing`);
			continue;
		}
		const manifest = readManifest(manifestPath);
		for (const section of DEPENDENCY_SECTIONS) {
			for (const dependency of Object.keys(manifest[section] ?? {})) {
				const target = packages.get(dependency);
				if (target && !allowedEdge(rule, target)) {
					violations.push(
						`${rule.root}/package.json: ${section}.${dependency} creates forbidden ${rule.root} -> ${target} edge`,
					);
				}
			}
		}
		for (const path of sourceFiles(modulePath)) {
			const file = normalized(relative(absoluteRoot, path));
			for (const sourceImport of importSpecifiers(path, file)) {
				const target = workspaceTarget(sourceImport.specifier, path, absoluteRoot, packages);
				const violation = sourceViolation(
					rule,
					normalized(relative(modulePath, path)),
					sourceImport,
					target,
					leaves.get(path),
				);
				if (violation)
					violations.push(`${file}: import ${JSON.stringify(sourceImport.specifier)} ${violation}`);
			}
		}
	}
	return violations.sort();
}

/** Every bare specifier `entry` loads, following its relative imports. */
export function bareImportClosure(entry: string): string[] {
	const bare = new Set<string>();
	const seen = new Set<string>();
	const visit = (path: string): void => {
		if (seen.has(path)) return;
		seen.add(path);
		for (const { specifier } of importSpecifiers(path, path)) {
			if (specifier.startsWith(".")) visit(resolve(dirname(path), specifier));
			else bare.add(specifier);
		}
	};
	visit(entry);
	return [...bare].sort();
}

if (import.meta.main) {
	const root = join(import.meta.dir, "..");
	const violations = moduleBoundaryViolations(root);
	if (violations.length > 0) {
		console.error("Module boundary violations:");
		for (const violation of violations) console.error(`  - ${violation}`);
		process.exit(1);
	}
	console.log(
		`check-module-boundaries: OK (${moduleRules(workspacePackages(root)).length} module boundaries enforced)`,
	);
}
