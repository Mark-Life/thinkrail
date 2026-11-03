import { arr, bool, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import { ProjectId, WorkspaceId } from "./ids";
import { wireObj } from "./wire";

export const SlashCommandSourceInfo = wireObj({
	path: str(),
	source: str(),
	scope: oneOf(["user", "project", "temporary"]),
	origin: oneOf(["package", "top-level"]),
	baseDir: opt(str()),
});
export type SlashCommandSourceInfo = Static<typeof SlashCommandSourceInfo>;

export const SlashCommandSource = oneOf(["extension", "prompt", "skill"]);
export type SlashCommandSource = Static<typeof SlashCommandSource>;

export const SlashCommandInfo = wireObj({
	name: str(),
	description: opt(str()),
	source: SlashCommandSource,
	sourceInfo: SlashCommandSourceInfo,
});
export type SlashCommandInfo = Static<typeof SlashCommandInfo>;

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
});
export type SkillCatalogEntry = Static<typeof SkillCatalogEntry>;

export const SKILL_METHODS = {
	"skill.list": { params: wireObj({ projectId: ProjectId }), result: arr(SlashCommandInfo) },
	"skills.state": { params: wireObj({ workspaceId: WorkspaceId }), result: arr(SkillCatalogEntry) },
};
