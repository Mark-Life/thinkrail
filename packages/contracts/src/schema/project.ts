import {
	arr,
	bool,
	lit,
	map,
	nullable,
	num,
	oneOf,
	opt,
	type Static,
	str,
} from "@earendil-works/pi-schema";
import { McpProjectOverride, McpToolGrant } from "./mcp";
import { SkillCatalogEntry } from "./skill";
import { Ack, NoParams, wireObj } from "./wire";

export const Project = wireObj({
	id: str(),
	name: str(),
	path: str(),
	slug: str(),
	lastOpened: num(),
	closed: opt(lit(true)),
	trusted: opt(bool()),
	acknowledgedSkills: opt(arr(str())),
	disabledSkills: opt(arr(str())),
	disabledGroups: opt(arr(str())),
	/**
	 * pi-level trust for the project's native `.pi/` resources, separate from the alias-skill `trusted`
	 * grant; absent (a record that predates pi-level trust) reads as untrusted. Never enables MCP servers by itself.
	 */
	piResourceTrust: opt(oneOf(["granted", "untrusted"])),
	/** Approved repo-defined MCP entries: server name → fingerprint of the original project-file entry. */
	mcpApprovals: opt(map(str())),
	/** Per-project enablement/exposure of user-level MCP servers (never written to `.pi/mcp.json`). */
	mcpOverrides: opt(map(McpProjectOverride)),
	/** "Always allow" MCP tools per server name (never written to `.pi/mcp.json`). */
	mcpToolGrants: opt(map(McpToolGrant)),
});
export type Project = Static<typeof Project>;

export const ProjectPathStatus = wireObj({
	kind: oneOf(["repo", "initable", "missing", "notDirectory"]),
});
export type ProjectPathStatus = Static<typeof ProjectPathStatus>;

/** A kind of the project's own pi resources; `extensions` and `settings` run code on the host. */
export const ProjectResourceKind = oneOf([
	"extensions",
	"settings",
	"skills",
	"prompts",
	"themes",
	"systemPrompt",
	"subagents",
]);
export type ProjectResourceKind = Static<typeof ProjectResourceKind>;

/**
 * What a project's trust grant would load, for the trust notice; alias skill names show only after trust.
 * `mcpServers` counts the entries of the project's `.pi/mcp.json`, each approved separately.
 */
export const ProjectTrustSummary = wireObj({
	aliasSkills: arr(str()),
	/** The kinds of the project's own pi resources a pi-level grant would load; empty when none. */
	piResources: arr(ProjectResourceKind),
	mcpServers: opt(num()),
});
export type ProjectTrustSummary = Static<typeof ProjectTrustSummary>;

export const PROJECT_METHODS = {
	"project.open": { params: wireObj({ path: str() }), result: Project },
	"project.list": { params: NoParams, result: arr(Project) },
	"project.close": { params: wireObj({ id: str() }), result: Ack },
	"project.rename": { params: wireObj({ id: str(), name: str() }), result: Project },
	"project.inspect": { params: wireObj({ path: str() }), result: ProjectPathStatus },
	"project.init": { params: wireObj({ path: str() }), result: Project },
	"project.create": {
		params: wireObj({ parentPath: str(), name: str(), displayName: opt(str()) }),
		result: Project,
	},
	"project.cloneDestination": {
		params: wireObj({ parentPath: str(), name: str() }),
		result: wireObj({ path: str() }),
	},
	"project.clone": {
		params: wireObj({
			operationId: str(),
			url: str(),
			parentPath: str(),
			name: str(),
			depth: opt(num()),
		}),
		result: nullable(Project),
	},
	"project.cancelClone": { params: wireObj({ operationId: str() }), result: Ack },
	"project.hasSpecs": {
		params: wireObj({ projectId: str() }),
		result: wireObj({ hasSpecs: bool() }),
	},
	"project.setTrust": {
		params: wireObj({ id: str(), trusted: bool(), resources: opt(bool()) }),
		result: Project,
	},
	"project.acknowledgeSkills": {
		params: wireObj({ id: str(), names: arr(str()) }),
		result: Project,
	},
	"project.setSkillEnabled": {
		params: wireObj({ id: str(), name: str(), enabled: bool() }),
		result: Project,
	},
	"project.aliasSkills": { params: wireObj({ projectId: str() }), result: arr(str()) },
	"project.trustSummary": { params: wireObj({ projectId: str() }), result: ProjectTrustSummary },
	"project.setGroupEnabled": {
		params: wireObj({ id: str(), group: str(), enabled: bool() }),
		result: Project,
	},
	"project.skills": { params: wireObj({ projectId: str() }), result: arr(SkillCatalogEntry) },
};

export const PROJECT_CHANNELS = {
	"project.updated": Project,
};
