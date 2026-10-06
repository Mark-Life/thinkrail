import { listProjectAliasSkillNames, listSkillCatalog, listSkillCommands } from "../../agent";
import {
	acknowledgeProjectSkills,
	closeProject,
	initProject,
	inspectProjectPath,
	listProjects,
	openProject,
	setProjectGroupEnabled,
	setProjectSkillEnabled,
	setProjectTrust,
} from "../../projects";
import { projectHasSpecs } from "../../spec";
import { getWorkspace } from "../../workspaces";
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
	"project.setTrust": async (p) => {
		const project = listProjects().find((candidate) => candidate.id === p.id);
		if (!project) throw new Error(`Unknown project: ${p.id}`);
		const acknowledged = p.trusted ? await listProjectAliasSkillNames(project.path) : undefined;
		return setProjectTrust(p.id, p.trusted, acknowledged);
	},
	"skill.list": (params) => {
		const { projectId } = params;
		const project = listProjects().find((candidate) => candidate.id === projectId);
		if (!project) throw new Error(`Unknown project: ${projectId}`);
		return listSkillCommands(project.path, {
			trusted: project.trusted === true,
			acknowledged: project.acknowledgedSkills ?? [],
			disabled: project.disabledSkills ?? [],
			disabledGroups: project.disabledGroups ?? [],
			overrides: {},
		});
	},
	"skills.state": (params) => {
		const { workspaceId } = params;
		const ws = getWorkspace(workspaceId);
		const project = listProjects().find((p) => p.id === ws.projectId);
		return listSkillCatalog(ws.worktreePath, {
			trusted: project?.trusted === true,
			acknowledged: project?.acknowledgedSkills ?? [],
			disabled: project?.disabledSkills ?? [],
			disabledGroups: project?.disabledGroups ?? [],
			overrides: ws.skillOverrides ?? {},
		});
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
	"project.setGroupEnabled": (p) => {
		return setProjectGroupEnabled(p.id, p.group, p.enabled);
	},
	"project.skills": (params) => {
		const { projectId } = params;
		const project = listProjects().find((p) => p.id === projectId);
		if (!project) throw new Error(`Unknown project: ${projectId}`);
		return listSkillCatalog(project.path, {
			trusted: project.trusted === true,
			acknowledged: project.acknowledgedSkills ?? [],
			disabled: project.disabledSkills ?? [],
			disabledGroups: project.disabledGroups ?? [],
			overrides: {},
		});
	},
};
