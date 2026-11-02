import { bool, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import { wireObj } from "./wire";

export const SlashCommandSourceInfo = wireObj({
	path: str(),
	source: str(),
	scope: oneOf(["user", "project", "temporary"]),
	origin: oneOf(["package", "top-level"]),
	baseDir: opt(str()),
});
export type SlashCommandSourceInfo = Static<typeof SlashCommandSourceInfo>;

export const SkillDecision = oneOf(["load", "untrusted", "pending-ack", "disabled"]);
export type SkillDecision = Static<typeof SkillDecision>;

export const SkillCatalogEntry = wireObj({
	name: str(),
	description: opt(str()),
	sourceInfo: SlashCommandSourceInfo,
	gated: bool(),
	plugin: opt(str()),
	group: str(),
	decision: SkillDecision,
	/** pi's `disable-model-invocation`: callable only as `/skill:`, never listed in the prompt. */
	manualOnly: opt(bool()),
});
export type SkillCatalogEntry = Static<typeof SkillCatalogEntry>;
