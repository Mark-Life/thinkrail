import { arr, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";

export const TODO_STATUSES = ["pending", "in_progress", "done"] as const;
export const TodoStatus = oneOf(TODO_STATUSES);
export type TodoStatus = Static<typeof TodoStatus>;

export const TODO_ORIGINS = ["agent", "user"] as const;
export const TodoOrigin = oneOf(TODO_ORIGINS);
export type TodoOrigin = Static<typeof TodoOrigin>;

export const TODO_ARTIFACT_KINDS = ["file", "change", "spec", "commit"] as const;
export const TodoArtifactKind = oneOf(TODO_ARTIFACT_KINDS);
export type TodoArtifactKind = Static<typeof TodoArtifactKind>;

export const TODO_GROUP_STATUSES = ["pending", "active", "done"] as const;
export const TodoGroupStatus = oneOf(TODO_GROUP_STATUSES);
export type TodoGroupStatus = Static<typeof TodoGroupStatus>;

export const TODO_ARTIFACT_FIELDS = {
	kind: TodoArtifactKind,
	path: opt(str()),
	label: opt(str()),
	specId: opt(str()),
	sha: opt(str()),
};
export const TodoArtifact = obj(TODO_ARTIFACT_FIELDS, { open: true });
export type TodoArtifact = Static<typeof TodoArtifact>;

export const TODO_FIELDS = {
	id: str(),
	title: str(),
	status: TodoStatus,
	origin: TodoOrigin,
	note: opt(str()),
	summary: opt(str()),
	verification: opt(str()),
	commitSubject: opt(str()),
	artifacts: opt(arr(TodoArtifact)),
	createdAt: str(),
	updatedAt: str(),
};
const Todo = obj(TODO_FIELDS, { open: true });

export const TODO_GROUP_FIELDS = { id: str(), title: str(), todos: arr(Todo) };
const TodoGroup = obj(TODO_GROUP_FIELDS, { open: true });

export const TODO_PLAN_FIELDS = {
	todos: arr(Todo),
	groups: arr(TodoGroup),
	summary: opt(str()),
};
