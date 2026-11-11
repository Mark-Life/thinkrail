import { join } from "node:path";
import { type ThemeSchemaNotes, themeManifestSchema } from "../src/themes/schema";

export const THEME_SCHEMA_PATH = join(import.meta.dir, "../src/themes/theme.schema.json");

const NOTES: ThemeSchemaNotes = {
	manifest: {
		title: "ThinkRail theme manifest",
		description:
			"A complete, declarative ThinkRail UI, terminal, and syntax palette. Selected-text foreground overrides may be null to retain native behavior.",
	},
	derived: {
		dangerHover: {
			description:
				"Destructive button hover fill. Optional: defaults to danger darkened 12% toward black.",
		},
		onDanger: {
			description:
				"Label on the destructive fills. Optional: defaults to the palette's text or background colour, whichever reads better on danger and dangerHover.",
		},
	},
};

export const renderThemeSchema = () =>
	`${JSON.stringify(
		{
			$schema: "https://json-schema.org/draft/2020-12/schema",
			$id: "https://thinkrail.dev/schemas/theme-manifest-v1.json",
			...themeManifestSchema(NOTES),
		},
		null,
		"\t",
	)}\n`;
