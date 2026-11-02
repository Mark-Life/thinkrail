import { arr, bool, num, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import { wireObj } from "./wire";

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
