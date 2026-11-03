import { compile, type Schema } from "@earendil-works/pi-schema";

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

export function randomUuid(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newProjectId() {
	return randomUuid() as ProjectId;
}

export function newWorkspaceId() {
	return randomUuid() as WorkspaceId;
}

function parserOf<T extends string>(schema: Schema<T>) {
	const { check } = compile(schema);
	return (value: unknown) => (check(value) ? value : null);
}

export const parseProjectId = parserOf(ProjectId);
export const parseWorkspaceId = parserOf(WorkspaceId);
export const parseSessionId = parserOf(SessionId);

export function testProjectId(id: string) {
	return id as ProjectId;
}

export function testWorkspaceId(id: string) {
	return id as WorkspaceId;
}

export function testSessionId(id: string) {
	return id as SessionId;
}
