import {
	arr,
	bool,
	compile,
	int,
	nullable,
	obj,
	opt,
	type Static,
	type StaticObject,
	str,
	unknown,
} from "@earendil-works/pi-schema";

const optText = opt(nullable(str()));

export const PR_HEAD_FIELDS = {
	headRepositoryOwner: opt(nullable(obj({ login: optText }, { open: true }))),
	headRepository: opt(nullable(obj({ name: optText }, { open: true }))),
};

const reviewId = opt(int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }));

const ProviderRows = arr(
	obj(
		{
			...PR_HEAD_FIELDS,
			number: reviewId,
			iid: reviewId,
			url: optText,
			web_url: optText,
			webUrl: optText,
			state: optText,
			mergedAt: optText,
			merged_at: optText,
			closedAt: optText,
			closed_at: optText,
			createdAt: optText,
			created_at: optText,
			isDraft: opt(nullable(bool())),
			mergeStateStatus: optText,
			reviewDecision: optText,
			baseRefName: optText,
			statusCheckRollup: opt(nullable(arr(unknown()))),
			latestReviews: opt(nullable(arr(unknown()))),
		},
		{ open: true },
	),
);
export type ProviderRow = Static<typeof ProviderRows>[number];
export const isProviderRows = compile(ProviderRows).check;

const CheckItem = obj(
	{
		__typename: optText,
		state: optText,
		status: optText,
		conclusion: optText,
		name: optText,
		context: optText,
		workflowName: optText,
		startedAt: optText,
		completedAt: optText,
		createdAt: optText,
	},
	{ open: true },
);
export type CheckItem = Static<typeof CheckItem>;
export const isCheckItem = compile(CheckItem).check;

const LatestReview = obj(
	{ author: opt(nullable(obj({ login: optText }, { open: true }))), state: optText },
	{ open: true },
);
export type LatestReview = Static<typeof LatestReview>;
export const isLatestReview = compile(LatestReview).check;

export const isRepoSettings = compile(
	obj(
		{
			squashMergeAllowed: opt(nullable(bool())),
			mergeCommitAllowed: opt(nullable(bool())),
			rebaseMergeAllowed: opt(nullable(bool())),
			deleteBranchOnMerge: opt(nullable(bool())),
		},
		{ open: true },
	),
).check;

/** `null` for output that is not JSON or fails the check. */
export function parseProviderJson<T>(
	output: string,
	isValid: (value: unknown) => value is T,
): T | null {
	try {
		const value: unknown = JSON.parse(output);
		return isValid(value) ? value : null;
	} catch {
		return null;
	}
}

export function headRepositorySlug(row: StaticObject<typeof PR_HEAD_FIELDS>): string | null {
	const login = row.headRepositoryOwner?.login;
	const name = row.headRepository?.name;
	return login && name ? `${login}/${name}`.toLowerCase() : null;
}
