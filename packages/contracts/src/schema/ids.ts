import { compile, type Schema, str } from "@earendil-works/pi-schema";

declare const ID_KIND: unique symbol;
declare const PATH_SAFE_ID: unique symbol;
interface Id<Kind extends string> {
	readonly [ID_KIND]: Kind;
}
interface PathSafe {
	readonly [PATH_SAFE_ID]: true;
}

export type ProjectId = string & Id<"project">;
export type WorkspaceId = string & Id<"workspace">;
export type StoredSessionId = string & Id<"session">;
export type SessionId = StoredSessionId & PathSafe;

const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const PATH_SAFE = {
	pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$",
	maxLength: 200,
};

function brandedString<T extends ProjectId | WorkspaceId | StoredSessionId>(
	options: Parameters<typeof str>[0],
) {
	return str(options) as Schema<T>;
}

export const ProjectId = brandedString<ProjectId>({ pattern: UUID });
export const WorkspaceId = brandedString<WorkspaceId>({ pattern: UUID });
export const SessionId = brandedString<SessionId>(PATH_SAFE);

export const StoredProjectId = brandedString<ProjectId>({ minLength: 1 });
export const StoredWorkspaceId = brandedString<WorkspaceId>(PATH_SAFE);
export const StoredSessionId = brandedString<StoredSessionId>({});

export function randomUuid(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parserOf<T>(schema: Schema<T>) {
	const { check } = compile(schema);
	return (value: unknown) => (check(value) ? value : null);
}

export const parseProjectId = parserOf(ProjectId);
export const parseWorkspaceId = parserOf(WorkspaceId);
export const parseSessionId = parserOf(SessionId);
export const parseStoredProjectId = parserOf(StoredProjectId);
export const parseStoredWorkspaceId = parserOf(StoredWorkspaceId);
export const parseStoredSessionId = parserOf(StoredSessionId);

function requireId<T>(parse: (value: unknown) => T | null, kind: string, value: string) {
	const id = parse(value);
	if (id === null) throw new Error(`Not a valid ${kind} id`);
	return id;
}

export function newProjectId() {
	return requireId(parseProjectId, "project", randomUuid());
}

export function newWorkspaceId() {
	return requireId(parseWorkspaceId, "workspace", randomUuid());
}

export function testProjectId(id: string) {
	return requireId(parseStoredProjectId, "project", id);
}

export function testWorkspaceId(id: string) {
	return requireId(parseStoredWorkspaceId, "workspace", id);
}

export function testSessionId(id: string) {
	return requireId(parseSessionId, "session", id);
}

export function testStoredSessionId(id: string) {
	return requireId(parseStoredSessionId, "stored session", id);
}
