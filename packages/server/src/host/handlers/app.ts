import type { TemplateReadLocation } from "@thinkrail/contracts";
import { selectDirectory } from "../../dialog";
import { listAvailableEditors } from "../../editors";
import { respondToInterview } from "../../feedback";
import { clampLimit, getHistoryIndex } from "../../history";
import { listProjects } from "../../projects";
import { updateConfig } from "../../settings";
import {
	deleteTemplate,
	getTemplate,
	listTemplates,
	saveTemplate,
	templateDirs,
} from "../../templates";
import { getWorkspace, listWorkspaceRecords } from "../../workspaces";
import { buildHistoryScope } from "../historyScope";
import { directoryPickOutcome, observeSetupAction } from "../productAnalytics";
import type { HandlersFor } from "./types";

function resolveTemplateReadDirs(params: TemplateReadLocation) {
	const { workspaceId, projectId } = params;
	if (workspaceId !== undefined && projectId !== undefined) {
		throw new Error("Template reads accept either workspaceId or projectId, not both");
	}
	if (workspaceId !== undefined) return templateDirs(getWorkspace(workspaceId).worktreePath);
	if (projectId === undefined) return templateDirs();
	const project = listProjects().find((candidate) => candidate.id === projectId);
	if (!project) throw new Error(`Unknown project: ${projectId}`);
	return templateDirs(project.path);
}

export const appHandlers: HandlersFor<
	"editor" | "dialog" | "host" | "settings" | "feedback" | "history" | "template"
> = {
	"editor.list": () => listAvailableEditors(),
	"dialog.selectDirectory": () =>
		observeSetupAction("directory_pick", selectDirectory, directoryPickOutcome),
	"host.update": (_params, ctx) => {
		if (!ctx.runHostUpdate) throw new Error("Host update is unavailable.");
		ctx.runHostUpdate();
		return { ok: true } as const;
	},
	"settings.update": (params) => {
		const config = params.config;
		return updateConfig(config);
	},
	"feedback.respond": (params) => {
		respondToInterview(params.action);
		return { ok: true } as const;
	},
	"history.search": (p) => {
		const { filter, labels } = buildHistoryScope(p.scope, listProjects(), (projectId) =>
			listWorkspaceRecords(projectId),
		);
		return getHistoryIndex().search({
			query: p.query,
			filter,
			labels,
			limit: clampLimit(p.limit),
		});
	},

	"template.list": (params) => ({
		templates: listTemplates(resolveTemplateReadDirs(params)),
	}),
	"template.get": (p) => {
		return getTemplate(resolveTemplateReadDirs(p), p.name, p.scope);
	},
	"template.save": (p) => {
		const dirs = templateDirs(p.workspaceId ? getWorkspace(p.workspaceId).worktreePath : undefined);
		return saveTemplate(dirs, p.scope, p.name, p.content);
	},
	"template.delete": (p) => {
		const dirs = templateDirs(p.workspaceId ? getWorkspace(p.workspaceId).worktreePath : undefined);
		deleteTemplate(dirs, p.scope, p.name);
		return { ok: true } as const;
	},
};
