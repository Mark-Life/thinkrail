import { revertChange, undoChange } from "../../changes";
import { readDir, readFile } from "../../fs";
import { gitDiffFile, gitStatus, listBranches, listCommits, prefetchBranch } from "../../git";
import { githubAuthStatus, githubRefresh } from "../../github";
import { openPr, previewPr } from "../../pr";
import { specGraph } from "../../spec";
import { ensureWatch } from "../../watch";
import { nudgeBaseRefWorkspaces } from "../fsNudge";
import { observePrAction } from "../productAnalytics";
import { withChangeLock } from "../reviewLock";
import type { HandlersFor } from "./types";

export const repoHandlers: HandlersFor<"git" | "change" | "fs" | "spec" | "github" | "pr"> = {
	"git.listBranches": (params) => listBranches(params.projectId),
	"git.prefetch": async (p) => {
		const { ok, moved } = await prefetchBranch(p.projectId, p.ref);
		if (moved) nudgeBaseRefWorkspaces(p.projectId, p.ref);
		return { ok };
	},
	"github.authStatus": () => githubAuthStatus(),
	"github.refresh": () => githubRefresh(),
	"pr.preview": (params) => previewPr(params),
	"pr.open": (params) => observePrAction(() => openPr(params)),
	"fs.readDir": (p) => {
		void ensureWatch(p.workspaceId);
		return readDir(p.workspaceId, p.path);
	},
	"fs.readFile": (p) => {
		void ensureWatch(p.workspaceId);
		return readFile(p.workspaceId, p.path);
	},
	"spec.graph": (p) => {
		void ensureWatch(p.workspaceId);
		return specGraph(p.workspaceId);
	},
	"git.status": (p) => {
		void ensureWatch(p.workspaceId);
		return gitStatus(p.workspaceId, p.scope);
	},

	"git.diffFile": (p) => {
		void ensureWatch(p.workspaceId);
		return gitDiffFile(p.workspaceId, p.path, p.scope);
	},
	"git.listCommits": (params) => listCommits(params.workspaceId),
	"change.revert": (p) => {
		void ensureWatch(p.workspaceId);
		return withChangeLock(p.workspaceId, async () => ({ receipt: await revertChange(p) }));
	},
	"change.undo": (p) => {
		void ensureWatch(p.workspaceId);
		return withChangeLock(p.workspaceId, async () => ({ receipt: await undoChange(p) }));
	},
};
