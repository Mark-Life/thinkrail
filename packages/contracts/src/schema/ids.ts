import { compile, type Schema, str } from "@earendil-works/pi-schema";

declare const ID_KIND: unique symbol;
interface Id<Kind extends string> {
	readonly [ID_KIND]: Kind;
}

export type ProjectId = string & Id<"project">;
export type WorkspaceId = string & Id<"workspace">;
export type SessionId = string & Id<"session">;

const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const PATH_SAFE = {
	pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$",
	maxLength: 200,
};

function brand<T extends string>(id: string) {
	return id as T;
}

function idSchema<T extends string>(options: Parameters<typeof str>[0]): Schema<T> {
	const keywords: Record<string, unknown> = str(options);
	return keywords;
}

export const ProjectId = idSchema<ProjectId>({ pattern: UUID });
export const WorkspaceId = idSchema<WorkspaceId>({ pattern: UUID });
export const SessionId = idSchema<SessionId>(PATH_SAFE);

export const StoredProjectId = idSchema<ProjectId>({ minLength: 1 });
export const StoredWorkspaceId = idSchema<WorkspaceId>(PATH_SAFE);
export const StoredSessionId = idSchema<SessionId>({});

export function randomUuid(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newProjectId() {
	return brand<ProjectId>(randomUuid());
}

export function newWorkspaceId() {
	return brand<WorkspaceId>(randomUuid());
}

function parserOf<T extends string>(schema: Schema<T>) {
	const { check } = compile(schema);
	return (value: unknown) => (check(value) ? value : null);
}

export const parseProjectId = parserOf(ProjectId);
export const parseWorkspaceId = parserOf(WorkspaceId);
export const parseSessionId = parserOf(SessionId);
export const parseStoredProjectId = parserOf(StoredProjectId);
export const parseStoredWorkspaceId = parserOf(StoredWorkspaceId);
export const parseStoredSessionId = parserOf(StoredSessionId);

export function testProjectId(id: string) {
	return brand<ProjectId>(id);
}

export function testWorkspaceId(id: string) {
	return brand<WorkspaceId>(id);
}

export function testSessionId(id: string) {
	return brand<SessionId>(id);
}
