import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildRuntimeSources } from "./buildSupportSchema";
import {
	resolveExtensionSkillRoots,
	STAGED_HOST_SKILLS_ROUTE,
	serverExtensions,
	stagedExtensionSkillRoute,
} from "./extensions";

export type { BuildRuntimeSources, DesktopRuntimeTarget } from "./buildSupportSchema";

const require = createRequire(import.meta.url);

function requiredPath(path: string): string {
	if (!existsSync(path)) throw new Error(`required runtime source is missing: ${path}`);
	return path;
}

export function resolveBuildRuntimeSources(): BuildRuntimeSources {
	const extensions = [
		"pi-spec-graph/index.ts",
		"pi-thinkrail-workflow/index.ts",
		"pi-todos/index.ts",
	].map((specifier) => ({ specifier, entry: require.resolve(specifier) }));
	const skillRoots: BuildRuntimeSources["skillRoots"] = [
		...extensions.map((pkg) => requiredPath(join(dirname(pkg.entry), "skills"))),
		requiredPath(fileURLToPath(new URL("../skills", import.meta.url))),
	].map((source) => ({ source, route: STAGED_HOST_SKILLS_ROUTE }));
	for (const entry of serverExtensions) {
		const route = stagedExtensionSkillRoute(entry.extension.name);
		for (const source of resolveExtensionSkillRoots(entry)) {
			skillRoots.push({ source: requiredPath(source), route });
		}
	}
	const ptyRelease = join(
		dirname(require.resolve("bun-pty")),
		"..",
		"rust-pty",
		"target",
		"release",
	);
	const trashLib = join(dirname(require.resolve("trash")), "lib");
	return {
		extensions,
		skillRoots,
		ptyLibraries: {
			"darwin-arm64": requiredPath(join(ptyRelease, "librust_pty_arm64.dylib")),
			"darwin-x64": requiredPath(join(ptyRelease, "librust_pty.dylib")),
			"linux-arm64": requiredPath(join(ptyRelease, "librust_pty_arm64.so")),
			"linux-x64": requiredPath(join(ptyRelease, "librust_pty.so")),
			"win32-x64": requiredPath(join(ptyRelease, "rust_pty.dll")),
		},
		trashHelpers: {
			macos: requiredPath(join(trashLib, "macos-trash")),
			windows: requiredPath(join(trashLib, "windows-trash.exe")),
		},
	};
}
