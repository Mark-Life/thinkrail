import type { SessionId } from "@thinkrail/contracts";
import type { Todo as StoredItem } from "pi-todos/core";
import type { TodoReviewRecord } from "./reviews";

const ADOPTED_COMMIT_ID = /^commit:([0-9a-f]{4,64})$/;

export function adoptedCommitSha(id: string): string | undefined {
	return ADOPTED_COMMIT_ID.exec(id)?.[1];
}

// origin is "agent": StoredItem has no "adopted"; the wire item gets "adopted" in listTodos. see todos/SPEC.md
export function commitShas(item: StoredItem): string[] {
	return (item.artifacts ?? []).flatMap((a) => (a.kind === "commit" && a.sha ? [a.sha] : []));
}

export function renderReviewPackage(
	item: StoredItem,
	workerSessionId: SessionId,
	prior: TodoReviewRecord | undefined,
): string {
	const shas = commitShas(item);
	const seen = new Set(prior?.reviewedShas ?? []);
	const fresh = shas.filter((s) => !seen.has(s));
	const paths = (item.artifacts ?? []).flatMap((a) =>
		a.kind === "change" && a.path ? [a.path] : [],
	);
	const changeSet =
		shas.length > 0
			? `commit${shas.length === 1 ? "" : "s"} ${shas.map((s) => s.slice(0, 12)).join(", ")}${paths.length > 0 ? `; uncommitted paths: ${paths.join(", ")}` : ""}`
			: `changed paths: ${paths.join(", ")}`;
	const rereview = prior && fresh.length > 0 && fresh.length < shas.length;
	// Facts-only reference — the reviewer role and output contract live in host/reviewerRole; see planReview.SPEC.
	const adopted = adoptedCommitSha(item.id);
	const subject = adopted
		? `Commit ${adopted.slice(0, 12)} ("${item.title}") of chat ${workerSessionId} belongs to no plan step and awaits review.`
		: `Plan step ${item.id} ("${item.title}") of chat ${workerSessionId} is done and awaits review.`;
	const lines = [
		subject,
		"",
		...(item.note ? [`Step note: ${item.note}`] : []),
		...(item.summary ? [`Worker's completion summary: ${item.summary}`] : []),
		...(item.verification
			? [`Worker's verification claim: ${item.verification} (verify the claim, don't trust it)`]
			: ["Worker reported NO verification — weigh that in your review."]),
		`Change set: ${changeSet}`,
		...(rereview
			? [
					`RE-REVIEW: only ${fresh.map((s) => s.slice(0, 12)).join(", ")} is new since the last verdict — review only that delta. Earlier findings the fix addressed are resolved by the worker or excluded as stale; approve is blocked only by what's still open.`,
				]
			: []),
	];
	return lines.join("\n");
}

export function renderFixPackage(item: StoredItem, feedback: string): string {
	const shas = commitShas(item);
	const paths = (item.artifacts ?? []).flatMap((a) =>
		a.kind === "change" && a.path ? [a.path] : [],
	);
	const changeSet =
		shas.length > 0
			? `commit${shas.length === 1 ? "" : "s"} ${shas.map((s) => s.slice(0, 12)).join(", ")}${paths.length > 0 ? `; uncommitted paths: ${paths.join(", ")}` : ""}`
			: `changed paths: ${paths.join(", ")}`;
	const lines = [
		`The user reviewed your completed step ${item.id} ("${item.title}") and asked for a fix.`,
		"",
		...(item.note ? [`Step note: ${item.note}`] : []),
		...(item.summary ? [`Your completion summary: ${item.summary}`] : []),
		...(item.verification ? [`Your verification claim: ${item.verification}`] : []),
		`Change set under review: ${changeSet}`,
		"",
		"User feedback:",
		'"""',
		feedback,
		'"""',
		"",
		adoptedCommitSha(item.id)
			? `Address the feedback by revising the change in ${changeSet}: make the fix and commit it. This commit belongs to no plan step, so there is nothing to re-open — your follow-up commit surfaces as a new entry. Leave unrelated commits untouched.`
			: `Address the feedback on THIS step: flip ${item.id} back to in_progress (todo_update), make the fix, then mark it done with a fresh summary AND a fresh commitSubject describing the fix (the revision is its own commit). Do not create a new item for it.`,
	];
	return lines.join("\n");
}
