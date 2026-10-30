import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";

export type CompatibilitySkillProvider = "claude" | "codex" | "github-copilot" | "gemini";

const PluginManifestSchema = Type.Object({ plugins: Type.Record(Type.String(), Type.Unknown()) });
const PluginInstallsSchema = Type.Array(Type.Unknown());
const PluginInstallSchema = Type.Object({ installPath: Type.String() });

const PROJECT_SKILL_PATH = /^\.(claude|github|gemini|pi|agents)\/skills(?:\/|$)/;

export function isProjectSkillPath(relativePath: string): boolean {
	return PROJECT_SKILL_PATH.test(relativePath.replaceAll("\\", "/"));
}

export interface CompatibilitySkillSource {
	path: string;
	scope: "project" | "user";
	provider: CompatibilitySkillProvider;
	plugin?: string;
}

interface DiscoverCompatibilitySkillSourcesOptions {
	homeDir?: string;
	env?: Readonly<Record<string, string | undefined>>;
}

function resolveConfiguredPath(value: string, homeDir: string): string {
	const trimmed = value.trim();
	if (trimmed === "~") return homeDir;
	if (/^~[\\/]/.test(trimmed)) return resolve(homeDir, trimmed.slice(2));
	return resolve(trimmed);
}

function existingDirectory(path: string): string | null {
	if (!existsSync(path)) return null;
	try {
		return statSync(path).isDirectory() ? resolve(path) : null;
	} catch {
		return null;
	}
}

function readClaudePluginSkillDirs(claudeConfigDir: string): { path: string; plugin: string }[] {
	const manifest = join(claudeConfigDir, "plugins", "installed_plugins.json");
	if (!existsSync(manifest)) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(manifest, "utf8"));
	} catch {
		return [];
	}
	if (!Check(PluginManifestSchema, parsed)) return [];
	const dirs: { path: string; plugin: string }[] = [];
	for (const [key, installs] of Object.entries(parsed.plugins)) {
		if (!Check(PluginInstallsSchema, installs)) continue;
		const plugin = key.split("@")[0] || key;
		for (const install of installs) {
			if (Check(PluginInstallSchema, install))
				dirs.push({ path: join(install.installPath, "skills"), plugin });
		}
	}
	return dirs;
}

export function candidateCompatibilitySkillRoots(
	cwd: string,
	options: DiscoverCompatibilitySkillSourcesOptions = {},
): CompatibilitySkillSource[] {
	const env = options.env ?? process.env;
	const configuredHome = options.homeDir?.trim() || env.HOME?.trim() || homedir();
	const homeDir = resolveConfiguredPath(configuredHome, homedir());
	const projectRoot = resolve(cwd);
	const claudeConfigDir = resolveConfiguredPath(
		env.CLAUDE_CONFIG_DIR?.trim() || join(homeDir, ".claude"),
		homeDir,
	);
	const codexHome = resolveConfiguredPath(
		env.CODEX_HOME?.trim() || join(homeDir, ".codex"),
		homeDir,
	);
	const geminiHome = resolveConfiguredPath(env.GEMINI_CLI_HOME?.trim() || homeDir, homeDir);

	const candidates: CompatibilitySkillSource[] = [
		{ path: join(projectRoot, ".claude", "skills"), scope: "project", provider: "claude" },
		{
			path: join(projectRoot, ".github", "skills"),
			scope: "project",
			provider: "github-copilot",
		},
		{ path: join(projectRoot, ".gemini", "skills"), scope: "project", provider: "gemini" },
		{ path: join(claudeConfigDir, "skills"), scope: "user", provider: "claude" },
		{ path: join(codexHome, "skills"), scope: "user", provider: "codex" },
		{
			path: join(homeDir, ".copilot", "skills"),
			scope: "user",
			provider: "github-copilot",
		},
		{ path: join(geminiHome, ".gemini", "skills"), scope: "user", provider: "gemini" },
	];

	for (const { path, plugin } of readClaudePluginSkillDirs(claudeConfigDir)) {
		candidates.push({ path, scope: "user", provider: "claude", plugin });
	}

	return candidates;
}

export function discoverCompatibilitySkillSources(
	cwd: string,
	options: DiscoverCompatibilitySkillSourcesOptions = {},
): CompatibilitySkillSource[] {
	const sources: CompatibilitySkillSource[] = [];
	const seen = new Set<string>();
	for (const candidate of candidateCompatibilitySkillRoots(cwd, options)) {
		const path = existingDirectory(candidate.path);
		if (!path) continue;
		let canonical = path;
		try {
			canonical = realpathSync(path);
		} catch {}
		if (seen.has(canonical)) continue;
		seen.add(canonical);
		sources.push({ ...candidate, path });
	}
	return sources;
}
