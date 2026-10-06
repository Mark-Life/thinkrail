import type { Workspace } from "@thinkrail/contracts";
import { refreshSubagentTools, removeWorkspaceSessions } from "../../agent";
import { findOpenBranchReview } from "../../branch-review";
import { forgetWorkspaceChanges } from "../../changes";
import { openEditor, revealInFileManager } from "../../editors";
import { countPushDivergence } from "../../git";
import { logger } from "../../log";
import { removeWorkspaceReviews } from "../../reviews";
import { evictSpecIndex } from "../../spec";
import { closeWorkspaceTerminals } from "../../terminal";
import { settleChangeArtifacts } from "../../todos";
import { ensureWatch, stopWatch } from "../../watch";
import {
	createWorkspace,
	forgetWorkspace,
	getWorkspace,
	listExistingWorktrees,
	listWorkspaces,
	openExistingWorktree,
	reclaimWorktree,
	renameWorkspace,
	setWorkspaceDiffBase,
	setWorkspaceSkillOverride,
	setWorkspaceSubagentsOverride,
	workspaceDiffStats,
} from "../../workspaces";
import { provisionInitialTerminal } from "../initialTerminal";
import { observeSetupAction } from "../productAnalytics";
import type { HandlersFor } from "./types";

const log = logger("host");

async function archiveTeardown(ws: Workspace): Promise<void> {
	try {
		await removeWorkspaceSessions(ws.id, ws.worktreePath);
		await settleChangeArtifacts(ws.id);
		reclaimWorktree(ws);
	} catch {
		log.warn(`workspace archive teardown failed for ${ws.id}`);
	}
}

export function shouldRefreshOpenReview(allowCached: boolean | undefined): boolean {
	return allowCached !== true;
}

export const workspaceHandlers: HandlersFor<"workspace"> = {
	"workspace.create": async (p) => {
		return provisionInitialTerminal(
			await observeSetupAction("worktree_create", () =>
				createWorkspace(p.projectId, p.name, p.baseRef),
			),
		);
	},
	"workspace.listExisting": (params) => listExistingWorktrees(params.projectId),
	"workspace.openExisting": async (p) => {
		return provisionInitialTerminal(
			await observeSetupAction("worktree_attach", () => openExistingWorktree(p.projectId, p.path)),
		);
	},
	"workspace.rename": (p) => {
		return renameWorkspace(p.id, p.name);
	},
	"workspace.list": async (p) => {
		return (
			await listWorkspaces(p.projectId, { includeDiffStats: p.includeDiffStats ?? true })
		).map((workspace) => ({ ...workspace, ...provisionInitialTerminal(workspace) }));
	},
	"workspace.openReview": async (p) => {
		const ws = getWorkspace(p.workspaceId);
		const fresh = shouldRefreshOpenReview(p.allowCached);
		const [review, divergence] = await Promise.all([
			findOpenBranchReview(ws.worktreePath, ws.branch, { fresh }),
			// Only pay the network fetch on a fresh lookup (focus / explicit refresh), not a cached activation.
			countPushDivergence(ws.worktreePath, ws.branch, { fetch: fresh }),
		]);
		if (!review) return review;
		return {
			...review,
			...(divergence && divergence.ahead > 0 ? { unpushedCommits: divergence.ahead } : {}),
			...(divergence && divergence.behind > 0 ? { behindCommits: divergence.behind } : {}),
		};
	},
	"workspace.remove": (params) => {
		const id = params.id;
		const ws = forgetWorkspace(id);
		if (ws) {
			evictSpecIndex(ws.id);
			removeWorkspaceReviews(ws.id);
			forgetWorkspaceChanges(ws.id);
			stopWatch(ws.id);
			closeWorkspaceTerminals(ws.id);
			void archiveTeardown(ws);
		}
		return { ok: true } as const;
	},
	"workspace.diffStats": (params) => workspaceDiffStats(params.id),
	"workspace.openIn": (p) => {
		openEditor(p.editor, getWorkspace(p.id).worktreePath);
		return { ok: true } as const;
	},
	"workspace.reveal": (params) => {
		revealInFileManager(getWorkspace(params.id).worktreePath);
		return { ok: true } as const;
	},
	"workspace.setSkillOverride": (p) => {
		return setWorkspaceSkillOverride(p.id, p.name, p.override);
	},
	"workspace.setSubagentsOverride": (p) => {
		const workspace = setWorkspaceSubagentsOverride(p.id, p.override);
		refreshSubagentTools(p.id);
		return workspace;
	},
	"workspace.setDiffBase": (p) => {
		return setWorkspaceDiffBase(p.id, p.ref);
	},
	"workspace.watchReady": (p) => {
		return ensureWatch(p.workspaceId, { prewarm: p.prewarm === true });
	},
};
