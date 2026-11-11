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
import {
	TODO_ARTIFACT_FIELDS,
	TODO_FIELDS,
	TODO_GROUP_FIELDS,
	TODO_ORIGINS,
	TODO_PLAN_FIELDS,
	TodoArtifactKind,
	TodoGroupStatus,
	TodoStatus,
} from "pi-todos/wire";
import { GitFileChange } from "./git";
import { SessionId, WorkspaceId } from "./ids";
import { Ack, wireObj } from "./wire";

export { TodoArtifactKind, TodoGroupStatus, TodoStatus };

export const TodoOrigin = oneOf([...TODO_ORIGINS, "adopted"]);
export type TodoOrigin = Static<typeof TodoOrigin>;

export const TodoArtifact = wireObj({ ...TODO_ARTIFACT_FIELDS, files: opt(arr(GitFileChange)) });
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
	...TODO_FIELDS,
	origin: TodoOrigin,
	artifacts: opt(arr(TodoArtifact)),
	/**
	 * The item's review decoration — **host-derived on `todo.list`, present only on reviewable items**
	 * (those carrying a host change set). Review state is user-owned and host-stored (a sidecar, never the
	 * agent-writable plan file), so an agent re-plan can't flip a review decision.
	 */
	review: opt(TodoReviewInfo),
});
export type TodoItem = Static<typeof TodoItem>;

export const TodoGroupItem = wireObj({
	...TODO_GROUP_FIELDS,
	todos: arr(TodoItem),
	status: TodoGroupStatus,
});
export type TodoGroupItem = Static<typeof TodoGroupItem>;

export const TodoPlan = wireObj({
	...TODO_PLAN_FIELDS,
	todos: arr(TodoItem),
	groups: arr(TodoGroupItem),
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

const { title, note, status } = TODO_FIELDS;
const TodoItemRef = wireObj({ workspaceId: WorkspaceId, sessionId: SessionId, id: str() });
const TodoPlanRef = wireObj({ workspaceId: WorkspaceId, sessionId: SessionId });

export const TODO_METHODS = {
	"todo.list": {
		params: wireObj({
			workspaceId: WorkspaceId,
			sessionId: SessionId,
			opened: opt(oneOf(["page", "rail"])),
		}),
		result: TodoPlan,
	},
	"todo.add": {
		params: wireObj({
			workspaceId: WorkspaceId,
			sessionId: SessionId,
			title,
			note,
			surface: opt(oneOf(["chat", "page", "rail"])),
		}),
		result: TodoItem,
	},
	"todo.update": {
		params: wireObj({
			workspaceId: WorkspaceId,
			sessionId: SessionId,
			id: str(),
			status: opt(status),
			title: opt(title),
			note,
		}),
		result: TodoItem,
	},
	"todo.remove": { params: TodoItemRef, result: Ack },
	"todo.review": { params: TodoItemRef, result: Ack },
	"todo.requestFix": {
		params: wireObj({ workspaceId: WorkspaceId, sessionId: SessionId, id: str(), feedback: str() }),
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
