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
	union,
} from "@earendil-works/pi-schema";
import { GitDiffScope } from "./diffScope";
import { ThinkingLevel, WireModel } from "./model";
import { Ack, wireObj } from "./wire";

export const ReviewCommentKind = oneOf(["inline", "diff", "file", "review"]);
export type ReviewCommentKind = Static<typeof ReviewCommentKind>;

export const ReviewCommentStatus = oneOf(["draft", "sent", "resolved", "dismissed"]);
export type ReviewCommentStatus = Static<typeof ReviewCommentStatus>;

export const ReviewAnchorState = oneOf(["anchored", "moved", "outdated"]);
export type ReviewAnchorState = Static<typeof ReviewAnchorState>;

export const ReviewSelector = union([
	wireObj({ kind: lit("lineRange"), startLine: num(), endLine: num() }),
	wireObj({ kind: lit("textQuote"), exact: str(), prefix: str(), suffix: str() }),
	wireObj({ kind: lit("diffHunk"), hunkHeader: str() }),
	wireObj({ kind: lit("structural"), scheme: str(), ref: str() }),
	wireObj({
		kind: lit("region"),
		x: num(),
		y: num(),
		width: num(),
		height: num(),
		page: opt(num()),
	}),
]);
export type ReviewSelector = Static<typeof ReviewSelector>;

export const ReviewAnchor = wireObj({
	path: str(),
	side: oneOf(["base", "worktree"]),
	baseRef: opt(str()),
	scope: opt(GitDiffScope),
	contentHash: opt(str()),
	selectors: arr(ReviewSelector),
});
export type ReviewAnchor = Static<typeof ReviewAnchor>;

export const ReviewComment = wireObj({
	id: str(),
	reviewId: str(),
	kind: ReviewCommentKind,
	anchor: nullable(ReviewAnchor),
	body: str(),
	status: ReviewCommentStatus,
	anchorState: ReviewAnchorState,
	sessionId: opt(str()),
	/** Who authored the remark — the human (default, absent) or the plan's reviewer agent. */
	author: opt(oneOf(["user", "agent"])),
	/** Provenance of an agent finding: the plan step (in its session) and the newest reviewed commit sha. */
	origin: opt(wireObj({ todoId: str(), reviewedSha: str(), sessionId: str() })),
	/** Server-derived for the client, never persisted: the reviewed code was overwritten after review. */
	stale: opt(bool()),
	resolvedBy: opt(oneOf(["agent", "user"])),
	resolveNote: opt(str()),
	createdAt: num(),
	sentAt: opt(num()),
	resolvedAt: opt(num()),
});
export type ReviewComment = Static<typeof ReviewComment>;

export const ReviewReadingStep = wireObj({ path: str(), why: str() });
export type ReviewReadingStep = Static<typeof ReviewReadingStep>;

export const PlanReviewVerdict = oneOf(["approve", "request_changes"]);
export type PlanReviewVerdict = Static<typeof PlanReviewVerdict>;

/** The newest reviewer verdict's narrative for the workspace: its one-paragraph summary and the order it
 * suggests reading the change set in. Written by the host when a plan-step verdict lands; the Changes
 * review tab walks it. */
export const ReviewGuide = wireObj({
	summary: str(),
	readingOrder: arr(ReviewReadingStep),
	verdict: PlanReviewVerdict,
	todoId: str(),
	sessionId: str(),
	reviewedSha: str(),
	at: num(),
});
export type ReviewGuide = Static<typeof ReviewGuide>;

export const Review = wireObj({
	id: str(),
	workspaceId: str(),
	status: oneOf(["open", "closed"]),
	baseSha: str(),
	fileSessions: opt(map(str())),
	doneFiles: opt(arr(str())),
	guide: opt(ReviewGuide),
	createdAt: num(),
	closedAt: opt(num()),
});
export type Review = Static<typeof Review>;

const ReviewSnapshotFields = { review: Review, comments: arr(ReviewComment) };

export const ReviewSnapshot = wireObj(ReviewSnapshotFields);
export type ReviewSnapshot = Static<typeof ReviewSnapshot>;

export const ReviewChangedPayload = wireObj({ ...ReviewSnapshotFields, workspaceId: str() });
export type ReviewChangedPayload = Static<typeof ReviewChangedPayload>;

/** A plan review that failed after `todo.startReview` acknowledged — the detached button/auto path has no
 * chat of its own, so the owning plan session raises the failure as a toast. `sessionId` routes it to that
 * plan only; duplicate views of one session dedupe on the toast body. See apps/web/src/panels/SPEC.md. */
export const ReviewFailedPayload = wireObj({
	workspaceId: str(),
	sessionId: str(),
	itemId: str(),
	itemTitle: str(),
	message: str(),
});
export type ReviewFailedPayload = Static<typeof ReviewFailedPayload>;

export const ReviewSendResult = wireObj({
	sessionId: str(),
	model: nullable(WireModel),
	thinkingLevel: ThinkingLevel,
	reused: bool(),
});
export type ReviewSendResult = Static<typeof ReviewSendResult>;

const ReviewRef = wireObj({ workspaceId: str() });
const ReviewCommentRef = wireObj({ workspaceId: str(), id: str() });

export const REVIEW_METHODS = {
	"review.get": { params: ReviewRef, result: ReviewSnapshot },
	"review.commentAdd": {
		params: wireObj({
			workspaceId: str(),
			kind: ReviewCommentKind,
			anchor: nullable(ReviewAnchor),
			body: str(),
			scope: opt(GitDiffScope),
		}),
		result: ReviewComment,
	},
	"review.commentUpdate": {
		params: wireObj({
			workspaceId: str(),
			id: str(),
			body: opt(str()),
			status: opt(ReviewCommentStatus),
		}),
		result: ReviewComment,
	},
	"review.commentDelete": { params: ReviewCommentRef, result: Ack },
	"review.fileDone": { params: wireObj({ workspaceId: str(), path: str() }), result: Ack },
	"review.sendComment": {
		params: wireObj({
			workspaceId: str(),
			id: str(),
			sessionId: opt(str()),
			model: opt(WireModel),
			thinkingLevel: opt(ThinkingLevel),
		}),
		result: ReviewSendResult,
	},
	"review.sendBatch": {
		params: wireObj({
			workspaceId: str(),
			commentIds: opt(arr(str())),
			sessionId: opt(str()),
			model: opt(WireModel),
			thinkingLevel: opt(ThinkingLevel),
		}),
		result: wireObj({ sessions: arr(ReviewSendResult) }),
	},
	"review.close": { params: ReviewRef, result: Ack },
};

export const REVIEW_CHANNELS = {
	"review.changed": ReviewChangedPayload,
	"review.failed": ReviewFailedPayload,
};
