import { join } from "node:path";
import ts from "typescript";
import type { RepoProgram } from "./program";
import { packageEntryFiles } from "./resolver";
import type { ExportInfo } from "./symbolContext";

const INDEX_FILE = /(^|\/)index\.tsx?$/;

export function collectExportInfo(repo: RepoProgram) {
	const entries = packageEntryFiles(repo.workspace);
	const info: ExportInfo = { exported: new Set(), barrel: new Set() };
	for (const { path, source, isTest } of repo.sources) {
		const moduleSymbol = repo.checker.getSymbolAtLocation(source);
		if (!moduleSymbol) continue;
		const isBarrel = !isTest && (INDEX_FILE.test(path) || entries.has(join(repo.root, path)));
		for (const exportSymbol of repo.checker.getExportsOfModule(moduleSymbol)) {
			const target =
				exportSymbol.flags & ts.SymbolFlags.Alias
					? repo.checker.getAliasedSymbol(exportSymbol)
					: exportSymbol;
			for (const declaration of target.declarations ?? []) {
				info.exported.add(declaration);
				if (isBarrel) info.barrel.add(declaration);
			}
		}
	}
	return info;
}
