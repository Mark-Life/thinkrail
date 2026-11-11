import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Schema, Static } from "@earendil-works/pi-schema";
import { ResolveCommentInput, type SessionId } from "@thinkrail/contracts";
import { Type } from "typebox";
import { requireSessionId } from "./requireSessionId";

export const RESOLVE_COMMENT_TOOL_NAME = "resolve_comment";

const toolParameters = <S extends Schema>(schema: S) => Type.Unsafe<Static<S>>(schema);
const parameters = toolParameters(ResolveCommentInput);

const DESCRIPTION = `Mark a review comment as resolved, after you have actually addressed it (by editing the file, or by answering when no change is needed). Only valid for comment ids you received in a review package in this conversation. If a comment is unclear or you disagree with it, reply in the conversation instead — do NOT resolve it.`;

export interface ResolveCommentOutcome {
	resolvedBody: string;
}

type ResolveCommentHandler = (
	sessionId: SessionId,
	commentId: string,
	note?: string,
) => ResolveCommentOutcome;

const unavailableHandler: ResolveCommentHandler = () => {
	throw new Error("Review comments are not available on this host.");
};

let handler = unavailableHandler;

export function setReviewCommentHandler(fn: ResolveCommentHandler | null): void {
	handler = fn ?? unavailableHandler;
}

export function createResolveCommentTool(): ToolDefinition<typeof parameters> {
	return {
		name: RESOLVE_COMMENT_TOOL_NAME,
		label: "Resolve Review Comment",
		description: DESCRIPTION,
		parameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { commentId, note } = params;
			const outcome = handler(requireSessionId(ctx.sessionManager.getSessionId()), commentId, note);
			return {
				content: [
					{
						type: "text",
						text: `Resolved review comment ${commentId} ("${truncate(outcome.resolvedBody, 80)}").`,
					},
				],
				details: { commentId, ...(note ? { note } : {}) },
			};
		},
	};
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function reviewToolExtension(pi: ExtensionAPI): void {
	pi.registerTool(createResolveCommentTool());
}
