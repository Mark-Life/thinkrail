import "./env";
import type { SessionId } from "@thinkrail/contracts";
import { testWorkspaceId } from "@thinkrail/contracts/test-ids";
import {
	abortSession,
	createSession,
	disposeAllSessions,
	promptSession,
	removeSession,
} from "@thinkrail/server/agent";

export interface StartedSession {
	sessionId: SessionId;
	model: string;
}

let counter = 0;

export async function startSession(cwd: string): Promise<StartedSession> {
	const result = await createSession({
		cwd,
		workspaceId: testWorkspaceId(`workflow-test-${++counter}`),
	});
	const model = result.model ? `${result.model.provider}/${result.model.id}` : "unknown";
	return { sessionId: result.sessionId, model };
}

export async function promptTurn(
	sessionId: SessionId,
	text: string,
	expectedAbort: () => boolean = () => false,
): Promise<void> {
	try {
		await promptSession(sessionId, text);
	} catch (error) {
		if (isAbortError(error) && expectedAbort()) return;
		throw error;
	}
}

function isAbortError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /abort/i.test(message);
}

export async function stopTurn(sessionId: SessionId): Promise<void> {
	try {
		await abortSession(sessionId);
	} catch {}
}

export async function endSession(sessionId: SessionId): Promise<void> {
	await removeSession(sessionId);
}

export function endAllSessions(): void {
	disposeAllSessions();
}
