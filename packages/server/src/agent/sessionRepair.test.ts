import { expect, test } from "bun:test";
import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type InteractiveTools, interactiveTools } from "../extensions";
import { repairDanglingToolCalls } from "./sessionRepair";
import { TOOL_RESPONSE_PENDING_TEXT } from "./toolResponses";

const INTERACTIVE: InteractiveTools = new Map([["ask_user_question", {}]]);

const QUESTION = {
	questions: [
		{
			question: "Which runtime?",
			header: "Runtime",
			options: [
				{ label: "Bun", description: "fast" },
				{ label: "Node", description: "compatible" },
			],
		},
	],
};

const assistantWithCalls = (
	calls: { id: string; name: string; args?: ToolCall["arguments"] }[],
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage =>
	fauxAssistantMessage(
		calls.map((c) => fauxToolCall(c.name, c.args ?? {}, { id: c.id })),
		{ stopReason },
	);

const assistantText = (text: string): AssistantMessage =>
	fauxAssistantMessage(text, { stopReason: "stop" });

const toolResult = (toolCallId: string, toolName: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId,
	toolName,
	content: [{ type: "text", text: "ok" }],
	isError: false,
	timestamp: Date.now(),
});

const user = (text: string): UserMessage => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp: Date.now(),
});

const firstText = (content: (TextContent | ImageContent)[]) =>
	content[0]?.type === "text" ? content[0].text : "";

test("a healthy transcript is untouched", () => {
	const sm = SessionManager.inMemory("/tmp/repair-test");
	sm.appendMessage(user("hi"));
	sm.appendMessage(assistantWithCalls([{ id: "b1", name: "bash" }]));
	sm.appendMessage(toolResult("b1", "bash"));
	const before = sm.buildSessionContext().messages.length;
	expect(repairDanglingToolCalls(sm, INTERACTIVE)).toEqual([]);
	expect(sm.buildSessionContext().messages.length).toBe(before);
});

test("a dangling generic tool call gets an error 'Operation aborted' result", () => {
	const sm = SessionManager.inMemory("/tmp/repair-test");
	sm.appendMessage(user("run it"));
	sm.appendMessage(assistantWithCalls([{ id: "b1", name: "bash" }]));
	expect(repairDanglingToolCalls(sm, INTERACTIVE)).toEqual([
		{ toolCallId: "b1", toolName: "bash" },
	]);
	const { messages } = sm.buildSessionContext();
	const repaired = messages.find((m) => m.role === "toolResult");
	expect(repaired).toBeDefined();
	if (repaired?.role !== "toolResult") throw new Error("unreachable");
	expect(repaired.toolCallId).toBe("b1");
	expect(repaired.isError).toBe(true);
	expect(firstText(repaired.content)).toContain("host restarted");
	expect(repairDanglingToolCalls(sm, INTERACTIVE)).toEqual([]);
});

test("a dangling interactive tool call is repaired to the canonical pending ack", () => {
	const sm = SessionManager.inMemory("/tmp/repair-test");
	sm.appendMessage(user("decide"));
	sm.appendMessage(assistantWithCalls([{ id: "q1", name: "ask_user_question", args: QUESTION }]));
	expect(repairDanglingToolCalls(sm, INTERACTIVE)).toEqual([
		{ toolCallId: "q1", toolName: "ask_user_question" },
	]);
	const repaired = sm.buildSessionContext().messages.find((m) => m.role === "toolResult");
	if (repaired?.role !== "toolResult") throw new Error("unreachable");
	expect(repaired.isError).toBe(false);
	expect(repaired.details).toEqual({ kind: "ack" });
	const text = firstText(repaired.content);
	expect(text).toBe(TOOL_RESPONSE_PENDING_TEXT);
});

test("a dangling call whose tool is not in the interactive map is repaired as an interrupted call", () => {
	const sm = SessionManager.inMemory("/tmp/repair-test");
	sm.appendMessage(user("decide"));
	sm.appendMessage(
		assistantWithCalls([{ id: "q-foreign", name: "ask_user_question", args: QUESTION }]),
	);
	repairDanglingToolCalls(sm, new Map());
	const repaired = sm.buildSessionContext().messages.find((m) => m.role === "toolResult");
	if (repaired?.role !== "toolResult") throw new Error("unreachable");
	expect(repaired.isError).toBe(true);
	expect(repaired.details).toBeUndefined();
	expect(firstText(repaired.content)).toContain("host restarted");
});

test("a disabled extension's tool is not interactive and gets the interrupted repair", () => {
	const sm = SessionManager.inMemory("/tmp/repair-test");
	sm.appendMessage(user("decide"));
	sm.appendMessage(
		assistantWithCalls([{ id: "q-off", name: "ask_user_question", args: QUESTION }]),
	);
	const disabled = interactiveTools((name) => name === "ask-user-question");
	expect(disabled.has("ask_user_question")).toBe(false);
	repairDanglingToolCalls(sm, disabled);
	const repaired = sm.buildSessionContext().messages.find((m) => m.role === "toolResult");
	if (repaired?.role !== "toolResult") throw new Error("unreachable");
	expect(repaired.isError).toBe(true);
	expect(repaired.details).toBeUndefined();
	expect(firstText(repaired.content)).toContain("host restarted");
});

test("a length-truncated ask is repaired as a terminal error, never an answerable ack", () => {
	const sm = SessionManager.inMemory("/tmp/repair-test");
	sm.appendMessage(user("decide"));
	sm.appendMessage(
		assistantWithCalls([{ id: "q-length", name: "ask_user_question", args: QUESTION }], "length"),
	);
	expect(repairDanglingToolCalls(sm, INTERACTIVE)).toEqual([
		{ toolCallId: "q-length", toolName: "ask_user_question" },
	]);
	const repaired = sm.buildSessionContext().messages.find((m) => m.role === "toolResult");
	if (repaired?.role !== "toolResult") throw new Error("unreachable");
	expect(repaired.isError).toBe(true);
	expect(repaired.details).toBeUndefined();
	expect(firstText(repaired.content)).toContain("output token limit");
});

test("several orphans in one batch are all paired (mixed ask + generic)", () => {
	const sm = SessionManager.inMemory("/tmp/repair-test");
	sm.appendMessage(user("both"));
	sm.appendMessage(
		assistantWithCalls([
			{ id: "b1", name: "bash" },
			{ id: "q1", name: "ask_user_question", args: QUESTION },
		]),
	);
	const repaired = repairDanglingToolCalls(sm, INTERACTIVE);
	expect(repaired.map((r) => r.toolCallId).sort()).toEqual(["b1", "q1"]);
	const results = sm.buildSessionContext().messages.filter((m) => m.role === "toolResult");
	expect(results).toHaveLength(2);
});

test("a partially completed tail batch repairs only the missing calls", () => {
	const sm = SessionManager.inMemory("/tmp/repair-test");
	sm.appendMessage(user("both"));
	sm.appendMessage(
		assistantWithCalls([
			{ id: "b1", name: "read" },
			{ id: "b2", name: "bash" },
		]),
	);
	sm.appendMessage(toolResult("b1", "read"));
	expect(repairDanglingToolCalls(sm, INTERACTIVE)).toEqual([
		{ toolCallId: "b2", toolName: "bash" },
	]);
	expect(repairDanglingToolCalls(sm, INTERACTIVE)).toEqual([]);
});

test("an errored tool call followed by a successful retry is never repaired", () => {
	const sm = SessionManager.inMemory("/tmp/repair-test");
	sm.appendMessage(user("write it"));
	sm.appendMessage(assistantWithCalls([{ id: "failed", name: "write" }], "error"));
	sm.appendMessage(assistantWithCalls([{ id: "retry", name: "write" }]));
	sm.appendMessage(toolResult("retry", "write"));
	sm.appendMessage(assistantText("done"));
	expect(repairDanglingToolCalls(sm, INTERACTIVE)).toEqual([]);
	expect(
		sm
			.buildSessionContext()
			.messages.some((message) => message.role === "toolResult" && message.toolCallId === "failed"),
	).toBe(false);
});

test("errored and aborted tail attempts never contribute repair candidates", () => {
	for (const stopReason of ["error", "aborted"] as const) {
		const sm = SessionManager.inMemory("/tmp/repair-test");
		sm.appendMessage(user("run it"));
		sm.appendMessage(assistantWithCalls([{ id: stopReason, name: "bash" }], stopReason));
		expect(repairDanglingToolCalls(sm, INTERACTIVE)).toEqual([]);
	}
});

test("errored and aborted attempts close an older repair candidate", () => {
	for (const stopReason of ["error", "aborted"] as const) {
		const sm = SessionManager.inMemory("/tmp/repair-test");
		sm.appendMessage(user("run it"));
		sm.appendMessage(assistantWithCalls([{ id: "old", name: "bash" }]));
		sm.appendMessage(assistantWithCalls([], stopReason));
		expect(repairDanglingToolCalls(sm, INTERACTIVE)).toEqual([]);
	}
});

test("a historical orphan is not repaired after a later replayable message", () => {
	const sm = SessionManager.inMemory("/tmp/repair-test");
	sm.appendMessage(user("run it"));
	sm.appendMessage(assistantWithCalls([{ id: "old", name: "bash" }]));
	sm.appendMessage(assistantText("recovered"));
	expect(repairDanglingToolCalls(sm, INTERACTIVE)).toEqual([]);
});

test("malformed trailing results prevent repair of the preceding batch", () => {
	const malformedResults = [
		[toolResult("foreign", "read")],
		[toolResult("expected", "write")],
		[toolResult("expected", "bash"), toolResult("expected", "bash")],
	];
	for (const results of malformedResults) {
		const sm = SessionManager.inMemory("/tmp/repair-test");
		sm.appendMessage(user("run it"));
		sm.appendMessage(
			assistantWithCalls([
				{ id: "expected", name: "bash" },
				{ id: "missing", name: "read" },
			]),
		);
		for (const result of results) sm.appendMessage(result);
		expect(repairDanglingToolCalls(sm, INTERACTIVE)).toEqual([]);
	}
});

test("only calls on the context path are considered — resulted calls never re-repair", () => {
	const sm = SessionManager.inMemory("/tmp/repair-test");
	sm.appendMessage(user("go"));
	sm.appendMessage(assistantWithCalls([{ id: "b1", name: "bash" }]));
	sm.appendMessage(toolResult("b1", "bash"));
	sm.appendMessage(assistantWithCalls([{ id: "b2", name: "bash" }]));
	expect(repairDanglingToolCalls(sm, INTERACTIVE).map((r) => r.toolCallId)).toEqual(["b2"]);
});
