import {
	admissionContextFor,
	applyPiResourceTrust,
	listProjectAliasSkillNames,
	listSkillCatalog,
	listSkillCommands,
	projectTrustSummary,
} from "../../agent";
import {
	acknowledgeProjectSkills,
	closeProject,
	initProject,
	inspectProjectPath,
	listProjects,
	openProject,
	renameProject,
	setProjectGroupEnabled,
	setProjectSkillEnabled,
	setProjectTrust,
} from "../../projects";
import { projectHasSpecs } from "../../spec";
import { getWorkspace, listWorkspaceRecords } from "../../workspaces";
import { observeSetupAction, observeSetupRead } from "../productAnalytics";
import type { HandlersFor } from "./types";

export const projectHandlers: HandlersFor<"project" | "skill" | "skills"> = {
	"project.open": (params) => observeSetupAction("project_open", () => openProject(params.path)),
	"project.inspect": (params) => inspectProjectPath(params.path),
	"project.init": (params) => observeSetupAction("project_init", () => initProject(params.path)),
	"project.list": () =>
		observeSetupRead(listProjects, (projects) => ({
			project_present: projects.length > 0 ? "yes" : "no",
		})),
	"project.hasSpecs": (params) => {
		const { projectId } = params;
		const project = listProjects().find((p) => p.id === projectId);
		return { hasSpecs: project ? projectHasSpecs(project.path) : false };
	},
	"project.close": (params) => {
		closeProject(params.id);
		return { ok: true } as const;
	},
	"project.rename": (params) => renameProject(params.id, params.name),
	"project.setTrust": async (p) => {
		const project = listProjects().find((candidate) => candidate.id === p.id);
		if (!project) throw new Error(`Unknown project: ${p.id}`);
		const acknowledged =
			p.trusted && project.trusted !== true
				? await listProjectAliasSkillNames(project.path)
				: undefined;
		const updated = setProjectTrust(p.id, p.trusted, acknowledged, {
			resources: p.resources === true,
		});
		const reloads = await applyPiResourceTrust(
			listWorkspaceRecords(p.id).map((workspace) => workspace.id),
		);
		const failed = Object.values(reloads).filter((disposition) => disposition === "failed").length;
		if (failed > 0) {
			throw new Error(
				`Trust was ${p.trusted ? "granted" : "revoked"}, but ${failed} open ${failed === 1 ? "chat" : "chats"} could not reload and still ${failed === 1 ? "runs" : "run"} with the previous trust — close or reload ${failed === 1 ? "it" : "them"}.`,
			);
		}
		return updated;
	},
	"skill.list": (params) => {
		const { projectId } = params;
		const project = listProjects().find((candidate) => candidate.id === projectId);
		if (!project) throw new Error(`Unknown project: ${projectId}`);
		return listSkillCommands(project.path, admissionContextFor(project));
	},
	"skills.state": (params) => {
		const { workspaceId } = params;
		const ws = getWorkspace(workspaceId);
		const project = listProjects().find((p) => p.id === ws.projectId);
		return listSkillCatalog(ws.worktreePath, admissionContextFor(project, ws.skillOverrides ?? {}));
	},
	"project.acknowledgeSkills": (p) => {
		return acknowledgeProjectSkills(p.id, p.names);
	},
	"project.setSkillEnabled": (p) => {
		return setProjectSkillEnabled(p.id, p.name, p.enabled);
	},
	"project.aliasSkills": (params) => {
		const { projectId } = params;
		const project = listProjects().find((p) => p.id === projectId);
		if (!project) throw new Error(`Unknown project: ${projectId}`);
		return listProjectAliasSkillNames(project.path);
	},
	"project.trustSummary": (params) => {
		const { projectId } = params;
		const project = listProjects().find((p) => p.id === projectId);
		if (!project) throw new Error(`Unknown project: ${projectId}`);
		return projectTrustSummary(project.path);
	},
	"project.setGroupEnabled": (p) => {
		return setProjectGroupEnabled(p.id, p.group, p.enabled);
	},
	"project.skills": (params) => {
		const { projectId } = params;
		const project = listProjects().find((p) => p.id === projectId);
		if (!project) throw new Error(`Unknown project: ${projectId}`);
		return listSkillCatalog(project.path, admissionContextFor(project));
	},
};
