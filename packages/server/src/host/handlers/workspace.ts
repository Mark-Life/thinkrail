import type { OpenBranchReview, Workspace } from "@thinkrail/contracts";
import { WORKSPACE_SETTLE_PROTOCOL_VERSION } from "@thinkrail/contracts";
import {
	refreshSubagentConcurrency,
	refreshSubagentTools,
	removeWorkspaceSessions,
} from "../../agent";
import { findBranchReviewOutcome } from "../../branch-review";
import { forgetWorkspaceChanges } from "../../changes";
import { openEditor, revealInFileManager } from "../../editors";
import { countPushDivergence } from "../../git";
import { logger } from "../../log";
import { removeWorkspaceReviews } from "../../reviews";
import { evictSpecIndex } from "../../spec";
import { closeWorkspaceTerminals } from "../../terminal";
import { settleChangeArtifacts } from "../../todos";
import { forgetWorkspaceTurns, listTurns } from "../../turns";
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
	settleWorkspace,
	setWorkspaceDiffBase,
	setWorkspaceReview,
	setWorkspaceSkillOverride,
	setWorkspaceSubagentMaxConcurrent,
	setWorkspaceSubagentsOverride,
	unsettleWorkspace,
	workspaceDiffStats,
} from "../../workspaces";
import { provisionInitialTerminal } from "../initialTerminal";
import { observeSetupAction } from "../productAnalytics";
import { scheduleLifecyclePass } from "../settledLifecycle";
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

export function openReviewForClient(
	review: OpenBranchReview | null,
	protocolVersion: number | undefined,
): OpenBranchReview | null {
	if (
		!review ||
		protocolVersion === undefined ||
		protocolVersion >= WORKSPACE_SETTLE_PROTOCOL_VERSION
	)
		return review;
	return review.state === undefined || review.state === "open" ? review : null;
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
		const rows = (
			await listWorkspaces(p.projectId, { includeDiffStats: p.includeDiffStats ?? true })
		).map((workspace) => ({ ...workspace, ...provisionInitialTerminal(workspace) }));
		void scheduleLifecyclePass(p.projectId).catch(() =>
			log.warn(`settled lifecycle pass failed for project ${p.projectId}`),
		);
		return rows;
	},
	"workspace.openReview": async (p, ctx) => {
		const ws = getWorkspace(p.workspaceId);
		const fresh = shouldRefreshOpenReview(p.allowCached);
		const [outcome, divergence] = await Promise.all([
			findBranchReviewOutcome(ws.worktreePath, ws.branch, { fresh }),
			// Only pay the network fetch on a fresh lookup (focus / explicit refresh), not a cached activation.
			countPushDivergence(ws.worktreePath, ws.branch, { fetch: fresh }),
		]);
		if (outcome.reliable) setWorkspaceReview(ws.id, outcome.value, ws.branch);
		const review = openReviewForClient(outcome.value, ctx.protocolVersion);
		if (!review) return review;
		return {
			...review,
			...(divergence && divergence.ahead > 0 ? { unpushedCommits: divergence.ahead } : {}),
			...(divergence && divergence.behind > 0 ? { behindCommits: divergence.behind } : {}),
		};
	},
	"workspace.settle": (params) => settleWorkspace(params.id),
	"workspace.unsettle": (params) => unsettleWorkspace(params.id),
	"workspace.remove": (params) => {
		const id = params.id;
		const ws = forgetWorkspace(id);
		if (ws) {
			evictSpecIndex(ws.id);
			removeWorkspaceReviews(ws.id);
			forgetWorkspaceChanges(ws.id);
			forgetWorkspaceTurns(ws.id);
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
	"workspace.turns": (p) => {
		getWorkspace(p.workspaceId);
		return { turns: listTurns(p.workspaceId) };
	},
	"workspace.setSkillOverride": (p) => {
		return setWorkspaceSkillOverride(p.id, p.name, p.override);
	},
	"workspace.setSubagentsOverride": (p) => {
		const workspace = setWorkspaceSubagentsOverride(p.id, p.override);
		refreshSubagentTools(p.id);
		return workspace;
	},
	"workspace.setSubagentMaxConcurrent": (p) => {
		const workspace = setWorkspaceSubagentMaxConcurrent(p.id, p.value);
		refreshSubagentConcurrency(p.id);
		return workspace;
	},
	"workspace.setDiffBase": (p) => {
		return setWorkspaceDiffBase(p.id, p.ref);
	},
	"workspace.watchReady": (p) => {
		return ensureWatch(p.workspaceId, { prewarm: p.prewarm === true });
	},
};
