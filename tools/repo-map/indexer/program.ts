import { join, relative } from "node:path";
import ts from "typescript";
import { buildWorkspaceIndex, createModuleResolver, type WorkspaceIndex } from "./resolver";

interface SourceEntry {
	path: string;
	source: ts.SourceFile;
	isTest: boolean;
}

export interface RepoProgram {
	root: string;
	program: ts.Program;
	checker: ts.TypeChecker;
	sources: SourceEntry[];
	pathOf: Map<ts.SourceFile, string>;
	imports: Map<string, Set<string>>;
	workspace: WorkspaceIndex;
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
	target: ts.ScriptTarget.ES2023,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	jsx: ts.JsxEmit.Preserve,
	skipLibCheck: true,
	strict: true,
	allowImportingTsExtensions: true,
	resolveJsonModule: true,
	esModuleInterop: true,
	noEmit: true,
	lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
	types: ["bun"],
};

const TEST_PATH = /(^|\/)(e2e|__tests__)\/|\.(test|spec)\.tsx?$/;

export function isTestPath(path: string) {
	return TEST_PATH.test(path);
}

export function isIndexedSource(path: string) {
	return /\.tsx?$/.test(path) && !path.endsWith(".d.ts");
}

export function buildProgram(input: { root: string; paths: readonly string[] }) {
	const { root, paths } = input;
	const workspace = buildWorkspaceIndex({ root, paths });
	const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
	host.getCurrentDirectory = () => root;
	const resolve = createModuleResolver({ index: workspace, options: COMPILER_OPTIONS, host });
	const imports = new Map<string, Set<string>>();
	host.resolveModuleNameLiterals = (literals, containingFile) => {
		const seen = imports.get(containingFile) ?? new Set<string>();
		imports.set(containingFile, seen);
		return literals.map((literal) => {
			const resolvedModule = resolve(literal.text, containingFile);
			if (resolvedModule) seen.add(resolvedModule.resolvedFileName);
			return { resolvedModule };
		});
	};
	const rootNames = paths.filter(isIndexedSource).map((path) => join(root, path));
	const program = ts.createProgram({ rootNames, options: COMPILER_OPTIONS, host });
	const checker = program.getTypeChecker();
	const sources: SourceEntry[] = [];
	const pathOf = new Map<ts.SourceFile, string>();
	for (const name of rootNames) {
		const source = program.getSourceFile(name);
		if (!source) continue;
		const path = relative(root, name);
		sources.push({ path, source, isTest: isTestPath(path) });
		pathOf.set(source, path);
	}
	sources.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const repoProgram: RepoProgram = {
		root,
		program,
		checker,
		sources,
		pathOf,
		imports,
		workspace,
	};
	return repoProgram;
}
