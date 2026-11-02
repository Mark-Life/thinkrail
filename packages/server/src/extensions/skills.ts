import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { arr, compile, obj, opt, str } from "@earendil-works/pi-schema";
import type { ServerExtensionEntry } from "./registry";

const SkillPackageManifest = compile(
	obj({ pi: opt(obj({ skills: opt(arr(str())) }, { open: true })) }, { open: true }),
);

export function resolveExtensionSkillRoots(entry: ServerExtensionEntry): string[] {
	const skillPackages = entry.extension.skillPackages ?? [];
	if (skillPackages.length === 0) return [];
	const extensionEntry = createRequire(import.meta.url).resolve(entry.specifier);
	const requireFromExtension = createRequire(extensionEntry);
	return skillPackages.flatMap((specifier) => {
		const manifestPath = requireFromExtension.resolve(`${specifier}/package.json`);
		const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
		const skills = SkillPackageManifest.check(manifest) ? (manifest.pi?.skills ?? []) : [];
		if (skills.length === 0) {
			throw new Error(
				`${entry.extension.name}: skill package ${specifier} declares no pi.skills directories`,
			);
		}
		return skills.map((dir) => resolve(dirname(manifestPath), dir));
	});
}

export const STAGED_HOST_SKILLS_ROUTE = "host";

export function stagedExtensionSkillRoute(name: string): string {
	return `extensions/${name}`;
}

export function extensionSkillRoots(
	entry: ServerExtensionEntry,
	stagedSkillsDir?: string,
): string[] {
	if (stagedSkillsDir === undefined) return resolveExtensionSkillRoots(entry);
	if ((entry.extension.skillPackages ?? []).length === 0) return [];
	return [join(stagedSkillsDir, ...stagedExtensionSkillRoute(entry.extension.name).split("/"))];
}
