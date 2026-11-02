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
import { GitFileChange } from "./git";
import { Ack, wireObj } from "./wire";

export const TodoStatus = oneOf(["pending", "in_progress", "done"]);
export type TodoStatus = Static<typeof TodoStatus>;

export const TodoOrigin = oneOf(["agent", "user", "adopted"]);
export type TodoOrigin = Static<typeof TodoOrigin>;

export const TodoArtifactKind = oneOf(["file", "change", "spec", "commit"]);
export type TodoArtifactKind = Static<typeof TodoArtifactKind>;

export const TodoArtifact = wireObj({
	kind: TodoArtifactKind,
	path: opt(str()),
	label: opt(str()),
	specId: opt(str()),
	sha: opt(str()),
	files: opt(arr(GitFileChange)),
});
export type TodoArtifact = Static<typeof TodoArtifact>;

export const TodoReviewState = oneOf(["unreviewed", "reviewed", "changes_requested"]);
export type TodoReviewState = Static<typeof TodoReviewState>;

export const TodoReviewInfo = wireObj({
	state: TodoReviewState,
	reviewing: opt(bool()),
	reviewedBy: opt(oneOf(["user", "agent"])),
	revision: num(),
	unreviewedShas: opt(arr(str())),
	feedback: opt(str()),
	at: opt(str()),
});
export type TodoReviewInfo = Static<typeof TodoReviewInfo>;

export const TodoItem = wireObj({
	id: str(),
	title: str(),
	status: TodoStatus,
	origin: TodoOrigin,
	note: opt(str()),
	summary: opt(str()),
	verification: opt(str()),
	commitSubject: opt(str()),
	artifacts: opt(arr(TodoArtifact)),
	/**
	 * The item's review decoration — **host-derived on `todo.list`, present only on reviewable items**
	 * (those carrying a host change set). Review state is user-owned and host-stored (a sidecar, never the
	 * agent-writable plan file), so an agent re-plan can't flip a review decision.
	 */
	review: opt(TodoReviewInfo),
	createdAt: str(),
	updatedAt: str(),
});
export type TodoItem = Static<typeof TodoItem>;

export const TodoGroupStatus = oneOf(["pending", "active", "done"]);
export type TodoGroupStatus = Static<typeof TodoGroupStatus>;

export const TodoGroupItem = wireObj({
	id: str(),
	title: str(),
	todos: arr(TodoItem),
	status: TodoGroupStatus,
});
export type TodoGroupItem = Static<typeof TodoGroupItem>;

export const TodoPlan = wireObj({
	todos: arr(TodoItem),
	groups: arr(TodoGroupItem),
	/**
	 * The agent's overall completion summary (`todo_plan_summary`), written when the whole plan is done.
	 * The plan page keeps it visible while an item re-opens, marked stale ("updating") until the agent
	 * rewrites it at the next completion; ungated external outputs (markdown export, PR body) still show it
	 * only while every item stays `done`, so a stale all-done story never leaves the app.
	 */
	summary: opt(str()),
	/**
	 * Worktree changes attributed to NO item of this plan — **host-derived on `todo.list`, present only
	 * when non-empty**. The honesty section of the review map: work no item claims (edits before the
	 * first work window, after the last `done`, or in a chat that never planned) stays visible instead
	 * of silently absent.
	 */
	unattributed: opt(arr(GitFileChange)),
	/** Committed counterpart of `unattributed`: `base..HEAD` commits no item owns, as wire-only `done` items (`origin: "adopted"`) — host-derived, never stored. See submodule-server-todos. */
	adoptedCommits: opt(arr(TodoItem)),
});
export type TodoPlan = Static<typeof TodoPlan>;

const TodoItemRef = wireObj({ workspaceId: str(), sessionId: str(), id: str() });
const TodoPlanRef = wireObj({ workspaceId: str(), sessionId: str() });

export const TODO_METHODS = {
	"todo.list": {
		params: wireObj({
			workspaceId: str(),
			sessionId: str(),
			opened: opt(oneOf(["page", "rail"])),
		}),
		result: TodoPlan,
	},
	"todo.add": {
		params: wireObj({
			workspaceId: str(),
			sessionId: str(),
			title: str(),
			note: opt(str()),
			surface: opt(oneOf(["chat", "page", "rail"])),
		}),
		result: TodoItem,
	},
	"todo.update": {
		params: wireObj({
			workspaceId: str(),
			sessionId: str(),
			id: str(),
			status: opt(TodoStatus),
			title: opt(str()),
			note: opt(str()),
		}),
		result: TodoItem,
	},
	"todo.remove": { params: TodoItemRef, result: Ack },
	"todo.review": { params: TodoItemRef, result: Ack },
	"todo.requestFix": {
		params: wireObj({ workspaceId: str(), sessionId: str(), id: str(), feedback: str() }),
		result: Ack,
	},
	"todo.startReview": { params: TodoItemRef, result: Ack },
	"todo.reviewAll": {
		params: TodoPlanRef,
		result: wireObj({ ok: lit(true), total: num(), alreadyRunning: opt(lit(true)) }),
	},
	"todo.generateSummary": {
		params: TodoPlanRef,
		result: wireObj({ summary: nullable(str()) }),
	},
};
