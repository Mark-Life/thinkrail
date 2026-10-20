import { defineConfig } from "oxfmt";

export default defineConfig({
	useTabs: true,
	printWidth: 100,
	singleQuote: false,
	semi: true,
	trailingComma: "all",
	sortImports: false,
	sortPackageJson: false,
	sortTailwindcss: false,
	astro: false,
	ignorePatterns: [
		"**/*.md",
		"**/*.yml",
		"**/*.yaml",
		".pi",
		"designs",
		"**/.claude",
		"apps/web/src/styles/generated",
		"apps/web/src/chat/generated",
	],
	overrides: [
		{
			files: ["*.json", "*.jsonc"],
			options: { trailingComma: "none" },
		},
	],
});
