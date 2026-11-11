import {
	parseSessionId,
	type ReviewSendResult,
	type SessionId,
	type WorkspaceId,
} from "@thinkrail/contracts";
import { t } from "@thinkrail/locales/react";
import {
	type CenterNavigationStamp,
	layoutOpenOptionsForNavigation,
	toast,
	useAppStore,
} from "../store";
import { errorText, getTransport, RequestError } from "../transport";
import { openChatInTab } from "./openChat";

async function showReviewChat(
	method: "review.sendComment" | "review.sendBatch",
	workspaceId: WorkspaceId,
	sent: ReviewSendResult,
	navigation: CenterNavigationStamp | null,
	background = false,
): Promise<void> {
	const sessionId = parseSessionId(sent.sessionId);
	if (sessionId === null)
		throw new RequestError("INVALID_REPLY", t("app.transport.invalidReply", { method }));
	if (sent.reused) {
		await openChatInTab(workspaceId, sessionId, navigation, background);
		return;
	}
	const store = useAppStore.getState();
	const routed = layoutOpenOptionsForNavigation(store, workspaceId, navigation);
	store.openChatSession(
		workspaceId,
		sessionId,
		sent.model,
		sent.thinkingLevel,
		undefined,
		background ? { ...routed, activate: false } : routed,
	);
}

export async function sendReviewComment(
	workspaceId: WorkspaceId,
	id: string,
	chatSessionId?: SessionId,
): Promise<void> {
	const navigation = useAppStore.getState().beginCenterNavigation(workspaceId);
	try {
		const sent = await getTransport().request("review.sendComment", {
			workspaceId,
			id,
			...(chatSessionId ? { sessionId: chatSessionId } : {}),
		});
		await showReviewChat("review.sendComment", workspaceId, sent, navigation);
	} catch (err) {
		toast.error(errorText(err), t("review.send.commentFailed"));
		throw err;
	}
}

export async function sendReviewBatch(
	workspaceId: WorkspaceId,
	commentIds?: string[],
	chatSessionId?: SessionId,
): Promise<void> {
	const navigation = useAppStore.getState().beginCenterNavigation(workspaceId);
	try {
		const { sessions } = await getTransport().request("review.sendBatch", {
			workspaceId,
			...(commentIds ? { commentIds } : {}),
			...(chatSessionId ? { sessionId: chatSessionId } : {}),
		});
		for (const [index, sent] of sessions.entries()) {
			await showReviewChat("review.sendBatch", workspaceId, sent, navigation, index > 0);
		}
	} catch (err) {
		toast.error(errorText(err), t("review.send.batchFailed"));
		throw err;
	}
}
