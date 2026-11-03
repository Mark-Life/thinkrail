import type { WorkspaceId } from "@thinkrail/contracts";
import { useState } from "react";
import { useAppStore } from "../store";
import { getTransport } from "../transport";
import { useWorkspaceRead } from "./useWorkspaceRead";

export function useWorkspaceReview(workspaceId: WorkspaceId | null): { failed: boolean } {
	const [failedFor, setFailedFor] = useState<string | null>(null);
	useWorkspaceRead(workspaceId, (id) => getTransport().request("review.get", { workspaceId: id }), {
		onResult: (result, id) => {
			setFailedFor(null);
			useAppStore.getState().setWorkspaceReview(id, result);
		},
		onFailure: (id) => setFailedFor(id),
	});
	return { failed: failedFor !== null && failedFor === workspaceId };
}
