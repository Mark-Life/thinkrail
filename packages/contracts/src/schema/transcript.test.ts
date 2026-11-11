import { expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { testStoredSessionId, testWorkspaceId } from "../testIds";
import { parseWsResult } from "../wireChecks";
import type { SessionSummary } from "./session";

const summary: SessionSummary = {
	sessionId: testStoredSessionId("s1"),
	workspaceId: testWorkspaceId("w1"),
	title: "Chat",
	model: null,
	thinkingLevel: "off",
	isStreaming: false,
	messageCount: 1,
	updatedAt: 1,
	live: false,
};

const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "done" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
};

test("session.getMessages accepts a full pi assistant message", () => {
	expect(parseWsResult("session.getMessages", { summary, messages: [assistant] }).ok).toBe(true);
});

test("session.getMessages accepts a pi-shaped message without the fields its body may omit", () => {
	const { role, content, timestamp } = assistant;
	expect(
		parseWsResult("session.getMessages", { summary, messages: [{ role, content, timestamp }] }).ok,
	).toBe(true);
});

test("session.getMessages refuses a message role the transcript does not carry", () => {
	const message = { role: "bashExecution", timestamp: 1 };
	expect(parseWsResult("session.getMessages", { summary, messages: [message] }).ok).toBe(false);
});
