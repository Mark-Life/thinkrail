import type { ProjectId, SessionId, WorkspaceId } from "@thinkrail/contracts";
import { asProjectId, asSessionId, asWorkspaceId } from "@thinkrail/contracts";
export type NavigationLocation =
	| { kind: "main" }
	| { kind: "project"; projectId: ProjectId }
	| { kind: "workspace"; projectId: ProjectId; workspaceId: WorkspaceId }
	| { kind: "chat"; projectId: ProjectId; workspaceId: WorkspaceId; sessionId: SessionId };

export const MAIN_LOCATION: NavigationLocation = { kind: "main" };

function encodeSegment(id: string): string {
	return encodeURIComponent(id);
}

function decodeSegment(segment: string | undefined): string | null {
	if (!segment) return null;
	try {
		const decoded = decodeURIComponent(segment);
		return decoded === "" ? null : decoded;
	} catch {
		return null;
	}
}

export function serializeLocation(location: NavigationLocation): string {
	switch (location.kind) {
		case "main":
			return "#/v1";
		case "project":
			return `#/v1/projects/${encodeSegment(location.projectId)}`;
		case "workspace":
			return `#/v1/projects/${encodeSegment(location.projectId)}/workspaces/${encodeSegment(location.workspaceId)}`;
		case "chat":
			return `#/v1/projects/${encodeSegment(location.projectId)}/workspaces/${encodeSegment(location.workspaceId)}/chats/${encodeSegment(location.sessionId)}`;
	}
}

export function parseFragment(fragment: string): NavigationLocation {
	const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
	if (raw === "" || raw === "/v1") return MAIN_LOCATION;
	const segments = raw.split("/");
	if (segments[0] !== "" || segments[1] !== "v1") return MAIN_LOCATION;
	if (segments[2] !== "projects") return MAIN_LOCATION;
	const rawProjectId = decodeSegment(segments[3]);
	if (!rawProjectId) return MAIN_LOCATION;
	const projectId = asProjectId(rawProjectId);
	if (segments.length === 4) return { kind: "project", projectId };
	if (segments[4] !== "workspaces") return MAIN_LOCATION;
	const rawWorkspaceId = decodeSegment(segments[5]);
	if (!rawWorkspaceId) return MAIN_LOCATION;
	const workspaceId = asWorkspaceId(rawWorkspaceId);
	if (segments.length === 6) return { kind: "workspace", projectId, workspaceId };
	if (segments[6] !== "chats" || segments.length !== 8) return MAIN_LOCATION;
	const sessionId = decodeSegment(segments[7]);
	if (!sessionId) return MAIN_LOCATION;
	return { kind: "chat", projectId, workspaceId, sessionId: asSessionId(sessionId) };
}
