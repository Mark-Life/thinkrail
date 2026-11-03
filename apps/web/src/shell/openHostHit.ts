import type { ProjectId, SearchHit, SessionId, Workspace, WorkspaceId } from "@thinkrail/contracts";

type WorkspaceTarget = Pick<Workspace, "id" | "projectId">;

export interface ChatLocation {
	readonly workspaceId: WorkspaceId;
	readonly projectId: ProjectId;
	readonly sessionId: SessionId;
	readonly messageIndex: number;
	readonly anchorText: string;
}

export interface HostHitTargets {
	readonly navigateToWorkspace: (
		workspace: WorkspaceTarget,
		sessionId?: SessionId,
	) => Promise<boolean>;
	readonly loadWorkspaceRow: (workspace: WorkspaceTarget) => Promise<boolean>;
	readonly openFile: (workspaceId: WorkspaceId, path: string) => Promise<void>;
	readonly openSpec: (workspaceId: WorkspaceId, path: string) => void;
	readonly openChatLocation: (location: ChatLocation) => void;
	readonly openPlan: (workspaceId: WorkspaceId) => void;
}

export async function openHostHit(hit: SearchHit, targets: HostHitTargets): Promise<void> {
	const workspace = { id: hit.workspaceId, projectId: hit.projectId };
	switch (hit.kind) {
		case "file":
			if (await targets.navigateToWorkspace(workspace)) {
				await targets.openFile(workspace.id, hit.path);
			}
			return;
		case "spec":
			if (await targets.navigateToWorkspace(workspace)) targets.openSpec(workspace.id, hit.path);
			return;
		case "transcript":
			if (!(await targets.loadWorkspaceRow(workspace))) return;
			targets.openChatLocation({
				workspaceId: workspace.id,
				projectId: workspace.projectId,
				sessionId: hit.sessionId,
				messageIndex: hit.messageIndex,
				anchorText: hit.anchorText,
			});
			return;
		case "plan":
			if (await targets.navigateToWorkspace(workspace, hit.sessionId)) {
				targets.openPlan(workspace.id);
			}
			return;
	}
}
