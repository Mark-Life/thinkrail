import {
	arr,
	bool,
	lit,
	nullable,
	num,
	oneOf,
	opt,
	type Static,
	str,
} from "@earendil-works/pi-schema";
import { SessionId, WorkspaceId } from "./ids";
import { Ack, wireObj } from "./wire";

export const BranchReviewState = oneOf(["open", "merged", "closed"]);
export type BranchReviewState = Static<typeof BranchReviewState>;

export const ReviewDecision = oneOf(["approved", "changes_requested", "review_required"]);
export type ReviewDecision = Static<typeof ReviewDecision>;

/** GitHub's `mergeStateStatus`, lower-cased. */
export const ReviewMergeState = oneOf([
	"clean",
	"unstable",
	"has_hooks",
	"blocked",
	"behind",
	"dirty",
	"draft",
	"unknown",
]);
export type ReviewMergeState = Static<typeof ReviewMergeState>;

export const MergeMethod = oneOf(["squash", "merge", "rebase"]);
export type MergeMethod = Static<typeof MergeMethod>;

export const ReviewChecks = wireObj({
	passing: num(),
	pending: num(),
	failing: num(),
	/** Bounded, in the provider's order. */
	failingNames: arr(str()),
});
export type ReviewChecks = Static<typeof ReviewChecks>;

export const ReviewDetails = wireObj({
	draft: bool(),
	/** The branch the PR merges into now — it may have been retargeted since the workspace was made. */
	base: opt(str()),
	/** Absent when the PR has no checks. */
	checks: opt(ReviewChecks),
	/** Absent when the repository requires no review and nobody decided. */
	reviewDecision: opt(ReviewDecision),
	/** Latest approving / change-requesting reviewers, bounded. */
	reviewers: arr(wireObj({ login: str(), state: oneOf(["approved", "changes_requested"]) })),
	mergeState: ReviewMergeState,
	/** What the repository allows; absent when `gh repo view` did not answer. */
	mergeMethods: opt(arr(MergeMethod)),
	/** The repository deletes head branches on merge itself. */
	deleteBranchOnMerge: opt(bool()),
});
export type ReviewDetails = Static<typeof ReviewDetails>;

export const OpenBranchReview = wireObj({
	kind: oneOf(["pull-request", "merge-request"]),
	number: num(),
	/** The review's web page, when the provider reported one — what makes the `PR #N` chip a link. */
	url: opt(str()),
	/** Absent on a pre-v78 host, which only ever reported open reviews. */
	state: opt(BranchReviewState),
	/** When the provider merged or closed the review, in ms. */
	changedAt: opt(num()),
	/** `workspace.openReview` only: local commits origin/<branch> doesn't have yet. */
	unpushedCommits: opt(num()),
	/**
	 * `workspace.openReview` only: last-known commits on origin/<branch> that HEAD doesn't have (the
	 * tracking ref may be cached when the fetch fails). A plain push must wait until they're integrated;
	 * this does not imply the checkout rewrote history or that a force-push is appropriate.
	 */
	behindCommits: opt(num()),
	/** v88 `workspace.branchStatus` only: an open GitHub PR's live review facts. Never in the host snapshot. */
	details: opt(ReviewDetails),
});
export type OpenBranchReview = Static<typeof OpenBranchReview>;

export const ReviewProvider = oneOf(["github", "gitlab"]);
export type ReviewProvider = Static<typeof ReviewProvider>;

export const MergePrResult = wireObj({
	/** `false` when GitHub queued the PR (merge queue / auto-merge) instead of merging it now. */
	merged: bool(),
	/** `deleteBranch` only: whether `origin/<branch>` is gone — never deleted for a queued PR. */
	branchDeleted: bool(),
	/** Why the deletion after a successful merge failed. */
	deleteError: opt(str()),
});
export type MergePrResult = Static<typeof MergePrResult>;

export const GhSetupProblem = oneOf(["missing", "unauthenticated"]);
export type GhSetupProblem = Static<typeof GhSetupProblem>;

export const PrDraft = wireObj({ title: str(), body: str() });
export type PrDraft = Static<typeof PrDraft>;

export const PrBodySource = oneOf(["plan", "commits", "template", "empty"]);
export type PrBodySource = Static<typeof PrBodySource>;

export const PrPreview = wireObj({
	title: str(),
	body: str(),
	/** v87: worktree-relative PR/MR templates the host found, in discovery order. */
	templates: opt(arr(str())),
	/** v87: whether the session (when one was given) has a plan body to render. */
	planAvailable: opt(bool()),
	/** v87: the source the body was rendered from. */
	source: opt(PrBodySource),
});
export type PrPreview = Static<typeof PrPreview>;

export const OpenPrResult = wireObj({
	action: oneOf(["created", "updated", "pushed", "compare"]),
	review: opt(OpenBranchReview),
	url: opt(str()),
	compareUrl: opt(str()),
	/** `updated` only: whether the `gh pr edit --body` refresh actually succeeded. */
	bodyRefreshed: opt(bool()),
	/** `compare` only: why the direct gh path was unavailable, when the host could tell. */
	ghProblem: opt(GhSetupProblem),
	dirtyFiles: num(),
});
export type OpenPrResult = Static<typeof OpenPrResult>;

const PrActionParams = {
	workspaceId: WorkspaceId,
	branch: str(),
	number: num(),
};

export const PR_METHODS = {
	"pr.preview": {
		params: wireObj({
			workspaceId: WorkspaceId,
			sessionId: opt(SessionId),
			title: opt(str()),
			source: opt(PrBodySource),
			template: opt(str()),
		}),
		result: PrPreview,
	},
	"pr.generate": {
		params: wireObj({ workspaceId: WorkspaceId, sessionId: opt(SessionId), template: opt(str()) }),
		result: wireObj({ body: nullable(str()) }),
	},
	"pr.ready": { params: wireObj(PrActionParams), result: Ack },
	"pr.merge": {
		params: wireObj({ ...PrActionParams, method: MergeMethod, deleteBranch: bool() }),
		result: MergePrResult,
	},
	"pr.reopen": { params: wireObj(PrActionParams), result: Ack },
	"pr.open": {
		params: wireObj({
			workspaceId: WorkspaceId,
			sessionId: opt(SessionId),
			branch: opt(str()),
			title: opt(str()),
			titleEdited: opt(bool()),
			body: opt(str()),
			draft: opt(bool()),
			source: opt(lit("plan_page")),
		}),
		result: OpenPrResult,
	},
};
