import {
	parseSessionId,
	type WorkspaceFsChangedPayload,
	type WorkspaceId,
	type WorkspaceWatchReadyResult,
	type WsParams,
	type WsResult,
} from "@thinkrail/contracts";
import { t } from "@thinkrail/locales/react";
import { selectWorkspaceTick, useAppStore } from "../store";
import { RequestError } from "./requestError";
import { getTransport } from "./wireTransport";

export interface SkillLoadDependencies {
	watchReady: (workspaceId: WorkspaceId, prewarm: boolean) => Promise<WorkspaceWatchReadyResult>;
	noteFsChanged: (payload: WorkspaceFsChangedPayload) => void;
	workspaceTick: (workspaceId: WorkspaceId) => number;
	createSession: (params: WsParams<"session.create">) => Promise<WsResult<"session.create">>;
	getSessionMessages: (
		params: WsParams<"session.getMessages">,
	) => Promise<WsResult<"session.getMessages">>;
	reloadSessionResources: (
		params: WsParams<"session.reloadResources">,
	) => Promise<WsResult<"session.reloadResources">>;
}

export function createSkillLoadRequests(deps: SkillLoadDependencies) {
	const pending = new Map<string, { preparation: Promise<number>; prewarm: boolean }>();

	const prepare = (workspaceId: WorkspaceId, prewarm: boolean): Promise<number> => {
		const existing = pending.get(workspaceId);
		if (existing && (prewarm || !existing.prewarm)) return existing.preparation;

		const started = deps.watchReady(workspaceId, prewarm).then(({ startupNudge }) => {
			if (startupNudge) {
				deps.noteFsChanged({
					workspaceId,
					paths: [],
					truncated: true,
					skillChange: "unknown",
				});
			}
			return deps.workspaceTick(workspaceId);
		});
		const preparation = started.finally(() => {
			if (pending.get(workspaceId)?.preparation === preparation) pending.delete(workspaceId);
		});
		pending.set(workspaceId, { preparation, prewarm });
		return preparation;
	};

	return {
		async prewarmWorkspaceSkillLoad(workspaceId: WorkspaceId): Promise<void> {
			await prepare(workspaceId, true);
		},
		async createSession(params: WsParams<"session.create">) {
			const syncedTick = await prepare(params.workspaceId, false);
			const created = await deps.createSession(params);
			const sessionId = parseSessionId(created.sessionId);
			if (sessionId === null)
				throw new RequestError(
					"INVALID_REPLY",
					t("app.transport.invalidReply", { method: "session.create" }),
				);
			return { result: { ...created, sessionId }, syncedTick };
		},
		async getSessionMessages(params: WsParams<"session.getMessages">) {
			const syncedTick = deps.workspaceTick(params.workspaceId);
			prepare(params.workspaceId, false).catch(() => {});
			const result = await deps.getSessionMessages(params);
			if (
				result.summary.workspaceId !== params.workspaceId ||
				result.summary.sessionId !== params.sessionId
			) {
				throw new Error("Session response did not match the requested workspace and session");
			}
			return {
				result: { ...result, summary: { ...result.summary, sessionId: params.sessionId } },
				syncedTick,
			};
		},
		async reloadSessionResources(
			workspaceId: WorkspaceId,
			params: WsParams<"session.reloadResources">,
		) {
			const syncedTick = await prepare(workspaceId, false);
			const result = await deps.reloadSessionResources(params);
			return { result, syncedTick };
		},
	};
}

const skillLoadRequests = createSkillLoadRequests({
	watchReady: (workspaceId, prewarm) =>
		getTransport().request(
			"workspace.watchReady",
			prewarm ? { workspaceId, prewarm: true } : { workspaceId },
		),
	noteFsChanged: (payload) => useAppStore.getState().noteFsChanged(payload),
	workspaceTick: (workspaceId) => selectWorkspaceTick(useAppStore.getState(), workspaceId),
	createSession: (params) => getTransport().request("session.create", params),
	getSessionMessages: (params) => getTransport().request("session.getMessages", params),
	reloadSessionResources: (params) => getTransport().request("session.reloadResources", params),
});

export const prewarmWorkspaceSkillLoad = skillLoadRequests.prewarmWorkspaceSkillLoad;
export const createSessionWithSkillBaseline = skillLoadRequests.createSession;
export const getSessionMessagesWithSkillBaseline = skillLoadRequests.getSessionMessages;
export const reloadSessionResourcesWithSkillBaseline = skillLoadRequests.reloadSessionResources;
