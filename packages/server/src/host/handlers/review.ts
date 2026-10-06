import type {
	ReviewComment,
	ReviewSendResult,
	ThinkingLevel,
	WireModel,
} from "@thinkrail/contracts";
import {
	createSession,
	ensureSessionAttached,
	followUpSession,
	notifyExtUi,
	promptSession,
} from "../../agent";
import { logger } from "../../log";
import {
	addComment,
	buildSendPackage,
	clearReview,
	deleteComment,
	fileReviewSession,
	getReviewSnapshot,
	markCommentsSent,
	markFileDone,
	REVIEW_LEVEL_KEY,
	reviewSessionKey,
	rollbackSend,
	sendableComments,
	updateComment,
} from "../../reviews";
import { ensureWatch } from "../../watch";
import { ensureWorkspaceScratchDir, getWorkspace } from "../../workspaces";
import { ackSend } from "../ackSend";
import { trackChatStarted } from "../authAnalytics";
import { resolveNewChatModel } from "../newChatModel";
import { withReviewLock } from "../reviewLock";
import { runObservation } from "../runAnalytics";
import { clearChangesRequestedIfResolved, markClientStale } from "../todoReview";
import type { HandlersFor } from "./types";

const log = logger("host");

function fireReviewPrompt(
	workspaceId: string,
	ids: string[],
	sessionId: string,
	pkg: string,
	send: (sessionId: string, text: string) => Promise<void> = promptSession,
): void {
	void ackSend(runObservation.send(sessionId, "internal", () => send(sessionId, pkg)))
		.then(undefined, (err) => {
			rollbackSend(workspaceId, ids, sessionId);
			notifyExtUi(
				sessionId,
				`Review send failed: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		})
		.catch(() => {
			log.warn("review send rollback failed");
		});
}

async function sendToFileChat(
	workspaceId: string,
	comments: ReviewComment[],
	opts: { model?: WireModel; thinkingLevel?: ThinkingLevel; sessionId?: string },
): Promise<ReviewSendResult> {
	const ids = comments.map((c) => c.id);
	const pkg = await buildSendPackage(workspaceId, comments);
	const ws = getWorkspace(workspaceId);
	const first = comments[0];
	const path = first ? reviewSessionKey(first) : REVIEW_LEVEL_KEY;
	const existing = opts.sessionId ?? (await fileReviewSession(workspaceId, path));
	if (existing && (await ensureSessionAttached(existing, workspaceId, ws.worktreePath))) {
		await markCommentsSent(workspaceId, ids, existing);
		fireReviewPrompt(workspaceId, ids, existing, pkg, followUpSession);
		return {
			sessionId: existing,
			model: null,
			thinkingLevel: "medium",
			reused: true,
		};
	}
	if (existing) {
		log.warn(
			`review ${workspaceId}: linked chat ${existing} is no longer on disk — starting a new review chat`,
		);
	}
	ensureWorkspaceScratchDir(ws);
	const defaults = await resolveNewChatModel(opts);
	const created = await createSession({
		cwd: ws.worktreePath,
		workspaceId,
		...(defaults.model ? { model: defaults.model } : {}),
		thinkingLevel: defaults.thinkingLevel,
	});
	trackChatStarted({
		sessionId: created.sessionId,
		model: defaults.model ? created.model : null,
	});
	await markCommentsSent(workspaceId, ids, created.sessionId);
	fireReviewPrompt(workspaceId, ids, created.sessionId, pkg);
	return { ...created, reused: false };
}

export const reviewHandlers: HandlersFor<"review"> = {
	"review.get": async (p) => {
		ensureWatch(p.workspaceId);
		return markClientStale(await getReviewSnapshot(p.workspaceId), p.workspaceId);
	},
	"review.commentAdd": (p) => {
		return withReviewLock(p.workspaceId, async () => addComment(p));
	},
	"review.commentUpdate": (p) => {
		return withReviewLock(p.workspaceId, async () => {
			const updated = await updateComment(p);
			// Resolving/dismissing the item's last open finding must clear its changes_requested verdict
			// too (no-op while findings remain), the same invariant as commentDelete.
			if (updated.origin?.todoId)
				await clearChangesRequestedIfResolved({
					workspaceId: p.workspaceId,
					sessionId: updated.origin.sessionId,
					id: updated.origin.todoId,
				});
			return updated;
		});
	},
	"review.commentDelete": (p) => {
		return withReviewLock(p.workspaceId, async () => {
			const origin = (await getReviewSnapshot(p.workspaceId)).comments.find(
				(c) => c.id === p.id,
			)?.origin;
			await deleteComment(p.workspaceId, p.id);
			// A changes_requested verdict must not outlive its findings: if this was the item's last open
			// finding, drop the verdict back to unreviewed.
			if (origin?.todoId)
				await clearChangesRequestedIfResolved({
					workspaceId: p.workspaceId,
					sessionId: origin.sessionId,
					id: origin.todoId,
				});
			return { ok: true } as const;
		});
	},
	"review.fileDone": (p) => {
		return withReviewLock(p.workspaceId, async () => {
			await markFileDone(p.workspaceId, p.path);
			return { ok: true } as const;
		});
	},
	"review.close": (p) => {
		return withReviewLock(p.workspaceId, async () => {
			await clearReview(p.workspaceId);
			return { ok: true } as const;
		});
	},
	"review.sendComment": (p) => {
		return withReviewLock(p.workspaceId, async () =>
			sendToFileChat(p.workspaceId, await sendableComments(p.workspaceId, [p.id]), p),
		);
	},
	"review.sendBatch": (p) => {
		return withReviewLock(p.workspaceId, async () => {
			const comments = await sendableComments(p.workspaceId, p.commentIds);
			const groups = new Map<string, typeof comments>();
			for (const comment of comments) {
				const key = reviewSessionKey(comment);
				groups.set(key, [...(groups.get(key) ?? []), comment]);
			}
			const sessions: ReviewSendResult[] = [];
			for (const group of groups.values()) {
				sessions.push(await sendToFileChat(p.workspaceId, group, p));
			}
			if (sessions.length === 0) throw new Error("No draft comments to send.");
			return { sessions };
		});
	},
};
