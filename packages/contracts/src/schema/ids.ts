import type { Schema } from "@earendil-works/pi-schema";

declare const ID_KIND: unique symbol;
interface Id<Kind extends string> {
	readonly [ID_KIND]: Kind;
}

export type ProjectId = string & Id<"project">;
export type WorkspaceId = string & Id<"workspace">;
export type SessionId = string & Id<"session">;

export const ProjectId: Schema<ProjectId> = { type: "string" };
export const WorkspaceId: Schema<WorkspaceId> = { type: "string" };
export const SessionId: Schema<SessionId> = { type: "string" };

export function asProjectId(id: string) {
	return id as ProjectId;
}

export function asWorkspaceId(id: string) {
	return id as WorkspaceId;
}

export function asSessionId(id: string) {
	return id as SessionId;
}
