import type { ReviewFixDetails } from "@thinkrail/contracts";
import { ensureSessionAttached, notifyExtUi, sendReviewFixToSession } from "../../agent";
import type { AdditionalAnalyticsCapture } from "../../analytics";
import {
	buildReviewFixDetails,
	buildSendPackage,
	getReviewSnapshot,
	markCommentsSent,
	rollbackSend,
} from "../../reviews";
import {
	addTodo,
	approveTodoReview,
	generateTodoSummary,
	listTodos,
	removeTodo,
	requestTodoFix,
	rollbackTodoFix,
	type TodoReviewRecord,
	updateTodo,
} from "../../todos";
import { getWorkspace } from "../../workspaces";
import { ackSend } from "../ackSend";
import { planReviewRunning } from "../planReviewQueue";
import { additionalCapture, captureAdditional } from "../productAnalytics";
import { startPlanReview } from "../requestReview";
import { withReviewLock } from "../reviewLock";
import { runObservation } from "../runAnalytics";
import { taskObservation } from "../taskAnalytics";
import {
	claimItemFix,
	isItemUnderActiveReview,
	itemFixFindings,
	releaseItemFix,
} from "../todoReview";
import type { HandlersFor } from "./types";

function fireTodoFixPrompt(
	p: { workspaceId: string; sessionId: string; id: string },
	pkg: string,
	details: ReviewFixDetails,
	previous: TodoReviewRecord | undefined,
	requested: TodoReviewRecord,
	findingIds: string[],
	capture: AdditionalAnalyticsCapture | null,
): void {
	void ackSend(
		runObservation.send(p.sessionId, "internal", () =>
			sendReviewFixToSession(p.sessionId, pkg, details),
		),
	)
		.then(
			() => {
				captureAdditional(capture, {
					name: "review_decided",
					params: { actor: "user", verdict: "changes_requested" },
				});
			},
			(err) => {
				rollbackTodoFix(p, previous, requested);
				if (findingIds.length > 0) rollbackSend(p.workspaceId, findingIds, p.sessionId);
				notifyExtUi(
					p.sessionId,
					`Fix request send failed: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			},
		)
		.catch((err) => {
			console.warn(`todo fix rollback failed: ${err instanceof Error ? err.message : err}`);
		})
		.finally(() => releaseItemFix(p.sessionId, p.id));
}

export const todoHandlers: HandlersFor<"todo"> = {
	"todo.list": (params) => listTodos(params),
	"todo.add": (params) => addTodo(params),
	"todo.update": async (p) => {
		const observeCompletion = taskObservation.begin(p.workspaceId, p.sessionId);
		const result = await updateTodo(p);
		if (p.status === "done") await observeCompletion();
		return result;
	},
	"todo.remove": (p) => {
		return removeTodo(p, () => isItemUnderActiveReview(p.sessionId, p.id));
	},
	"todo.review": (params) => {
		const capture = additionalCapture();
		const result = approveTodoReview(params);
		captureAdditional(capture, {
			name: "review_decided",
			params: { actor: "user", verdict: "approved" },
		});
		return result;
	},
	"todo.startReview": async (p) => {
		const ws = getWorkspace(p.workspaceId);
		if (!(await ensureSessionAttached(p.sessionId, p.workspaceId, ws.worktreePath)))
			throw new Error("This plan's chat is no longer on disk — can't review.");
		if (!startPlanReview(p.workspaceId, p.sessionId, p.id))
			throw new Error("This step is already being reviewed.");
		return { ok: true };
	},
	"todo.reviewAll": async (p) => {
		const ws = getWorkspace(p.workspaceId);
		if (!(await ensureSessionAttached(p.sessionId, p.workspaceId, ws.worktreePath)))
			throw new Error("This plan's chat is no longer on disk — can't review.");
		const plan = await listTodos({ workspaceId: p.workspaceId, sessionId: p.sessionId });
		const items = [
			...plan.todos,
			...plan.groups.flatMap((g) => g.todos),
			...(plan.adoptedCommits ?? []),
		];
		const targets = items.filter((it) => {
			const r = it.review;
			return (
				r !== undefined &&
				!(r.state === "reviewed" && (r.unreviewedShas?.length ?? 0) === 0) &&
				r.reviewing !== true
			);
		});
		const started = targets.filter((it) => startPlanReview(p.workspaceId, p.sessionId, it.id));
		if (started.length === 0 && planReviewRunning(p.workspaceId, p.sessionId))
			return { ok: true, total: 0, alreadyRunning: true };
		return { ok: true, total: started.length };
	},
	"todo.generateSummary": (params) => generateTodoSummary(params),
	"todo.requestFix": async (p) => {
		const capture = additionalCapture();
		if (!claimItemFix(p.sessionId, p.id))
			throw new Error(`A fix request is already active for ${p.id}.`);
		try {
			const ws = getWorkspace(p.workspaceId);
			if (!(await ensureSessionAttached(p.sessionId, p.workspaceId, ws.worktreePath))) {
				throw new Error("This plan's chat is no longer on disk — can't send the fix request.");
			}
			const prepared = await withReviewLock(p.workspaceId, async () => {
				const request = requestTodoFix(p);
				try {
					const reviewId = (await getReviewSnapshot(p.workspaceId)).review.id;
					const findings = await itemFixFindings(p);
					const details = buildReviewFixDetails({
						itemId: p.id,
						itemTitle: request.itemTitle,
						reviewId,
						note: p.feedback.trim(),
						comments: findings,
					});
					if (findings.length === 0)
						return { ...request, fixText: request.pkg, details, findingIds: [] as string[] };
					const fixText = `${request.pkg}\n\n${await buildSendPackage(p.workspaceId, findings)}`;
					const findingIds = findings.map((c) => c.id);
					await markCommentsSent(p.workspaceId, findingIds, p.sessionId);
					return { ...request, fixText, details, findingIds };
				} catch (error) {
					rollbackTodoFix(p, request.previous, request.requested);
					throw error;
				}
			});
			try {
				fireTodoFixPrompt(
					p,
					prepared.fixText,
					prepared.details,
					prepared.previous,
					prepared.requested,
					prepared.findingIds,
					capture,
				);
			} catch (error) {
				if (prepared.findingIds.length > 0)
					rollbackSend(p.workspaceId, prepared.findingIds, p.sessionId);
				rollbackTodoFix(p, prepared.previous, prepared.requested);
				throw error;
			}
			return { ok: true } as const;
		} catch (error) {
			releaseItemFix(p.sessionId, p.id);
			throw error;
		}
	},
};
