import { isControlMessage } from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import {
	abortSession,
	acknowledgeCompletion,
	answerQuestion,
	clearQueueSession,
	compactSession,
	createSession,
	deleteSession,
	ensureSessionAttached,
	followUpSession,
	getSessionCommands,
	getSessionMessages,
	getSessionResources,
	getSessionStats,
	getSessionWorkspaceId,
	hasSession,
	isHostResourceId,
	isPiSessionId,
	listSessionStates,
	listSessions,
	nudgeSession,
	promptSession,
	readBackgroundCommandOutput,
	readChildTranscript,
	reloadSessionResources,
	removeQueuedSession,
	removeSession,
	renameSession,
	resolveExtUi,
	setSessionModel,
	setSessionThinkingLevel,
	steerSession,
	stopAllSubagents,
	stopBackgroundCommand,
	stopSubagent,
} from "../../agent";
import { type SendMode, track } from "../../analytics";
import { recordAcceptedMessage } from "../../feedback";
import { noteRecentModel } from "../../settings";
import { countOpenTodos, removeSessionTodoWindows } from "../../todos";
import { ensureWorkspaceScratchDir, getWorkspace, listAllWorkspaceRecords } from "../../workspaces";
import { ackSend } from "../ackSend";
import { sessionProviderAnalytics, trackChatStarted } from "../authAnalytics";
import { resolveNewChatModel } from "../newChatModel";
import { runObservation } from "../runAnalytics";
import { taskObservation } from "../taskAnalytics";
import type { HandlersFor } from "./types";

async function sendUserMessage(
	mode: SendMode,
	sessionId: string,
	text: string,
	clientKey: string,
	operation: () => Promise<void>,
): Promise<{ ok: true }> {
	const control = isControlMessage(text);
	const provider = control ? undefined : sessionProviderAnalytics(sessionId);
	await ackSend(runObservation.send(sessionId, control ? "internal" : "user", operation));
	if (provider) {
		track({
			name: "message_sent",
			params: { mode, provider: provider.provider, auth_method: provider.auth_method },
		});
		recordAcceptedMessage(clientKey);
	}
	return { ok: true };
}

function resourceCwd(workspaceId: string): string {
	try {
		return getWorkspace(workspaceId).worktreePath;
	} catch {
		throw new CodedError("RESOURCE_UNAVAILABLE", "Session resources unavailable");
	}
}

function resourceParams<K extends string>(params: unknown, keys: K[]): Record<K, string> {
	if (!params || typeof params !== "object" || Array.isArray(params))
		throw new Error("Invalid resource ids");
	if (Object.keys(params).some((key) => !keys.some((allowed) => allowed === key)))
		throw new Error("Invalid resource ids");
	const result = {} as Record<K, string>;
	for (const key of keys) {
		const value: unknown = Reflect.get(params, key);
		const sessionId = key === "sessionId" || key === "parentSessionId" || key === "childSessionId";
		if (typeof value !== "string" || !(sessionId ? isPiSessionId(value) : isHostResourceId(value)))
			throw new Error("Invalid resource ids");
		result[key] = value;
	}
	return result;
}

export const sessionHandlers: HandlersFor<"session" | "backgroundCommand" | "subagent"> = {
	"session.reloadResources": async (params) => {
		await reloadSessionResources(params.sessionId);
		return { ok: true } as const;
	},
	"session.create": async (p) => {
		const ws = getWorkspace(p.workspaceId);
		ensureWorkspaceScratchDir(ws);
		const defaults = await resolveNewChatModel(p);
		const created = await createSession({
			cwd: ws.worktreePath,
			workspaceId: p.workspaceId,
			...(defaults.model ? { model: defaults.model } : {}),
			thinkingLevel: defaults.thinkingLevel,
		});
		if (p.model && created.model) noteRecentModel(created.model);
		trackChatStarted({
			sessionId: created.sessionId,
			model: defaults.model ? created.model : null,
		});
		return created;
	},
	"session.prompt": (p, ctx) => {
		return sendUserMessage("prompt", p.sessionId, p.text, ctx.clientKey, () =>
			promptSession(p.sessionId, p.text, p.images),
		);
	},
	"session.steer": (p, ctx) => {
		return sendUserMessage("steer", p.sessionId, p.text, ctx.clientKey, () =>
			steerSession(p.sessionId, p.text, p.images),
		);
	},
	"session.followUp": (p, ctx) => {
		return sendUserMessage("follow_up", p.sessionId, p.text, ctx.clientKey, () =>
			followUpSession(p.sessionId, p.text, p.images),
		);
	},
	"session.clearQueue": (p) => {
		const cleared = clearQueueSession(p.sessionId, p.requireTextOnly);
		runObservation.clearQueue(p.sessionId);
		return cleared;
	},
	"session.removeQueued": async (p) => {
		const result = await removeQueuedSession(p.sessionId, p.kind, p.index);
		if (result.queue.steering.length === 0 && result.queue.followUp.length === 0) {
			runObservation.clearQueue(p.sessionId);
		}
		return result;
	},
	"session.abort": async (p) => {
		const stopping = abortSession(p.sessionId, p.restoreQueue);
		if (p.restoreQueue) runObservation.clearQueue(p.sessionId);
		const restoredQueue = await stopping;
		return {
			ok: true,
			...(restoredQueue ? { restoredQueue } : {}),
		} as const;
	},
	"session.dispose": async (params) => {
		const { sessionId } = params;
		await removeSession(sessionId);
		runObservation.forget(sessionId);
		taskObservation.forget(sessionId);
		return { ok: true } as const;
	},
	"session.delete": async (p) => {
		await deleteSession(p.sessionId, p.workspaceId, getWorkspace(p.workspaceId).worktreePath);
		await removeSessionTodoWindows(p);
		return { ok: true } as const;
	},
	"session.rename": async (p) => {
		await renameSession(
			p.sessionId,
			p.workspaceId,
			getWorkspace(p.workspaceId).worktreePath,
			p.title,
		);
		return { ok: true } as const;
	},
	"session.setModel": async (p) => {
		noteRecentModel(await setSessionModel(p.sessionId, p.model));
		return { ok: true } as const;
	},
	"session.setThinkingLevel": (p) => {
		setSessionThinkingLevel(p.sessionId, p.level);
		return { ok: true } as const;
	},
	"session.compact": async (p) => {
		await compactSession(p.sessionId, p.instructions);
		return { ok: true } as const;
	},
	"session.getStats": (params) => getSessionStats(params.sessionId),
	"session.getCommands": (params) => getSessionCommands(params.sessionId),
	"session.list": async (params) => {
		const { workspaceId } = params;
		const summaries = await listSessions(workspaceId, getWorkspace(workspaceId).worktreePath);
		return summaries.map((summary) => {
			try {
				return {
					...summary,
					openTodos: countOpenTodos({ workspaceId, sessionId: summary.sessionId }),
				};
			} catch {
				return summary;
			}
		});
	},
	"session.stateList": () =>
		listSessionStates(
			listAllWorkspaceRecords().map((workspace) => ({
				id: workspace.id,
				projectId: workspace.projectId,
				cwd: workspace.worktreePath,
			})),
		),
	"session.acknowledgeCompletion": (p) => {
		return acknowledgeCompletion(p.sessionId, p.completionId);
	},
	"session.nudge": async (p) => {
		const workspace = getWorkspace(p.workspaceId);
		const attachedWorkspaceId = getSessionWorkspaceId(p.sessionId);
		if (
			(attachedWorkspaceId !== undefined && attachedWorkspaceId !== p.workspaceId) ||
			(attachedWorkspaceId === undefined &&
				!(await ensureSessionAttached(p.sessionId, p.workspaceId, workspace.worktreePath)))
		) {
			throw new Error(`Unknown session: ${p.sessionId}`);
		}
		if (!isControlMessage(p.text)) throw new Error("Session nudge must be a control message");
		const nudge = nudgeSession(p.sessionId, p.text, p.images);
		if (nudge.disposition !== "needs_input") {
			await ackSend(runObservation.send(p.sessionId, "internal", nudge.send));
		}
		return { disposition: nudge.disposition };
	},
	"session.activityList": () => [],
	"session.getMessages": (p) => {
		return getSessionMessages(p.sessionId, p.workspaceId, getWorkspace(p.workspaceId).worktreePath);
	},
	"session.resources": (params) => {
		const p = resourceParams(params, ["workspaceId", "sessionId"]);
		return getSessionResources(p.workspaceId, p.sessionId, resourceCwd(p.workspaceId));
	},
	"backgroundCommand.output": (params) => {
		const p = resourceParams(params, ["workspaceId", "sessionId", "commandId"]);
		return readBackgroundCommandOutput(
			p.workspaceId,
			p.sessionId,
			p.commandId,
			resourceCwd(p.workspaceId),
		);
	},
	"backgroundCommand.stop": async (params) => {
		const p = resourceParams(params, ["workspaceId", "sessionId", "commandId"]);
		await stopBackgroundCommand(
			p.workspaceId,
			p.sessionId,
			p.commandId,
			resourceCwd(p.workspaceId),
		);
		return { ok: true } as const;
	},
	"subagent.stop": async (params) => {
		const p = resourceParams(params, ["workspaceId", "parentSessionId", "childSessionId"]);
		await stopSubagent(
			p.workspaceId,
			p.parentSessionId,
			p.childSessionId,
			resourceCwd(p.workspaceId),
		);
		return { ok: true } as const;
	},
	"subagent.stopAll": async (params) => {
		const p = resourceParams(params, ["workspaceId", "parentSessionId"]);
		const targeted = await stopAllSubagents(
			p.workspaceId,
			p.parentSessionId,
			resourceCwd(p.workspaceId),
		);
		return { ok: true, targeted } as const;
	},
	"subagent.getTranscript": (p) => {
		getWorkspace(p.workspaceId);
		return readChildTranscript(p.workspaceId, p.parentSessionId, p.childSessionId);
	},
	"session.extUiReply": (params) => {
		resolveExtUi(params.response);
		return { ok: true } as const;
	},
	"session.answerQuestion": async (p) => {
		if (!hasSession(p.sessionId)) throw new Error(`Unknown session: ${p.sessionId}`);
		if (!p.result || !Array.isArray(p.result.answers) || typeof p.result.cancelled !== "boolean")
			throw new Error("Malformed ask_user_question result");
		await ackSend(answerQuestion(p.sessionId, p.toolCallId, p.result));
		return { ok: true } as const;
	},
};
