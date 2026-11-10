import type { StaticObject } from "@earendil-works/pi-schema";
import type { TODO_FIELDS, TODO_GROUP_FIELDS, TODO_PLAN_FIELDS } from "./wire.ts";

export {
	TODO_ARTIFACT_KINDS,
	TODO_GROUP_STATUSES,
	TODO_ORIGINS,
	TODO_STATUSES,
	type TodoArtifact,
	type TodoArtifactKind,
	type TodoGroupStatus,
	type TodoOrigin,
	type TodoStatus,
} from "./wire.ts";

export type Todo = StaticObject<typeof TODO_FIELDS>;

export type TodoGroup = StaticObject<typeof TODO_GROUP_FIELDS>;

export type TodoPlan = StaticObject<typeof TODO_PLAN_FIELDS>;

export interface TodoFile extends TodoPlan {
	version: 6;
}

export type TodoInput = Pick<Todo, "title"> &
	Partial<Pick<Todo, "note" | "origin" | "artifacts">> & { group?: string; after?: string };

export interface TodoUpdateResult {
	todo: Todo;
	paused: Todo[];
}

export type TodoPromoteFailure = "unknown-id" | "grouped-step" | "empty-title" | "title-collision";

export type TodoPromoteResult =
	| { ok: true; group: TodoGroup }
	| { ok: false; reason: TodoPromoteFailure };

export type TodoPatch = Partial<
	Pick<
		Todo,
		"title" | "status" | "note" | "summary" | "verification" | "commitSubject" | "artifacts"
	>
>;

export type WriteItem = Pick<Todo, "title"> &
	Partial<Pick<Todo, "status" | "note" | "summary" | "verification" | "artifacts">>;

export interface WritePlan {
	groups?: { title: string; todos: WriteItem[] }[];
}

/** A read that lost data or could not run; the codes are the host's state-file codes. */
export interface TodoStoreProblem {
	code: "STATE_FILE_SET_ASIDE" | "STATE_FILE_UNREADABLE";
	message: string;
}
