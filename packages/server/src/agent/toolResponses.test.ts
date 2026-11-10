import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	InMemoryCredentialStore,
	type StopReason,
	type ToolCall,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { NON_EXECUTABLE_STOP_REASONS, TOOL_RESPONSE_CUSTOM_TYPE } from "@thinkrail/contracts";
import {
	extensionSessionServices,
	type InteractiveTools,
	interactiveTools,
	serverExtensions,
} from "../extensions";
import type { AgentMessage } from "./piTypes";
import {
	assessRespondability,
	awaitingToolCallId,
	buildToolResponseMessage,
	createToolResponseWaiters,
	describeToolResponse,
	hasPendingToolResult,
	RESPONDABILITY_ERRORS,
	TOOL_RESPONSE_PENDING_TEXT,
	TOOL_RESPONSE_STOPPED_ERROR,
	type ToolResponseWaiters,
	toolResponseSessionServices,
} from "./toolResponses";

const INTERACTIVE: InteractiveTools = new Map([["ask_user_question", {}]]);

/** A tool result as the host persists a turn: pi's message, with only the call id required. */
type PersistedToolResult = Pick<ToolResultMessage, "toolCallId"> &
	Partial<Pick<ToolResultMessage, "toolName" | "content" | "details" | "isError">>;

const root = mkdtempSync(join(tmpdir(), "thinkrail-tool-responses-"));
const sessions: AgentSession[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The ask-user-question tool and its `message_end` hook, composed by the host into a real pi session. */
async function composeAsk(waiters: ToolResponseWaiters, { hasUI = true } = {}) {
	const extension = serverExtensions.find(
		(candidate) => candidate.extension.name === "ask-user-question",
	)?.extension;
	if (!extension) throw new Error("the ask-user-question extension is not registered");
	const services = extensionSessionServices(extension, {
		...toolResponseSessionServices(waiters),
		workspaceFiles: { check: async () => {}, scratchDir: "" },
	});
	const cwd = mkdtempSync(join(root, "session-"));
	const agentDir = join(cwd, ".pi-agent");
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: extension.sessionExtensions?.(services) ?? [],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		modelRuntime: await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		}),
		noTools: "builtin",
	});
	sessions.push(session);
	const runner = session.extensionRunner;
	if (hasUI) runner.setUIContext(runner.getUIContext(), "rpc");
	const definition = session.getToolDefinition("ask_user_question");
	if (!definition) throw new Error("the ask-user-question extension registered no tool");
	return {
		executionMode: definition.executionMode,
		execute: (toolCallId: string, params: unknown, signal?: AbortSignal) =>
			definition.execute(
				toolCallId,
				params,
				signal,
				undefined,
				runner.createToolContext(toolCallId, signal),
			),
		messageEnd: (message: AgentMessage) => runner.emitMessageEnd({ type: "message_end", message }),
	};
}

const askTool = composeAsk;

const libraryQuestion = {
	question: "Which library?",
	header: "Lib",
	options: [
		{ label: "date-fns", description: "small" },
		{ label: "luxon", description: "rich" },
	],
};

const args = (questions: (typeof libraryQuestion)[] = [libraryQuestion]) => ({ questions });

const luxon = {
	cancelled: false,
	answers: [{ questionIndex: 0, question: "Which library?", kind: "option", answer: "luxon" }],
};

const declined = { answers: [], cancelled: true };

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
	r.content.map((c) => c.text ?? "").join("");

const run = async (params: unknown = args()) =>
	(await askTool(createToolResponseWaiters())).execute("tc-1", params);

const toolCall = (
	toolCallId: string,
	name: string,
	a: ToolCall["arguments"] = args(),
	stopReason: StopReason = "toolUse",
): AgentMessage => fauxAssistantMessage(fauxToolCall(name, a, { id: toolCallId }), { stopReason });

const askCall = (
	toolCallId: string,
	a: ToolCall["arguments"] = args(),
	stopReason: StopReason = "toolUse",
) => toolCall(toolCallId, "ask_user_question", a, stopReason);

const toolResult = (
	toolCallId: string,
	text: string,
	details: NonNullable<ToolResultMessage["details"]>,
): ToolResultMessage => ({
	role: "toolResult",
	toolCallId,
	toolName: "ask_user_question",
	content: [{ type: "text", text }],
	details,
	isError: false,
	timestamp: 1,
});

const pendingResult = (toolCallId: string) =>
	toolResult(toolCallId, TOOL_RESPONSE_PENDING_TEXT, { kind: "ack" });

const persistedResponse = (
	toolCallId: string,
	details: NonNullable<ToolResultMessage["details"]>,
): PersistedToolResult => ({
	toolCallId,
	content: [{ type: "text", text: "whatever the tool told the model" }],
	details,
	isError: false,
});

const finalResult = (toolCallId: string) =>
	toolResult(toolCallId, "User declined to answer questions", declined);

type CustomMessage = Extract<AgentMessage, { role: "custom" }>;

const customMessage = (
	fields: Pick<CustomMessage, "customType" | "content" | "display" | "details">,
): CustomMessage => ({ role: "custom", ...fields, timestamp: 1 });

const responseMessage = (toolCallId: string, response: unknown = declined) =>
	customMessage(
		buildToolResponseMessage("User has answered your questions: …", toolCallId, response),
	);

const legacyAnswersMessage = (toolCallId: string) =>
	customMessage({
		customType: "ask-user-answers",
		content: "User has answered your questions: …",
		display: true,
		details: { toolCallId, result: declined },
	});

const userMessage = (text = "actually, let me explain"): UserMessage => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp: 1,
});

test("the host path accepts more than four questions in one call", async () => {
	const many = args(
		Array.from({ length: 6 }, (_, index) => ({
			question: `Question ${index + 1}?`,
			header: `Q${index + 1}`,
			options: [
				{ label: "First", description: "Use the first choice." },
				{ label: "Second", description: "Use the second choice." },
			],
		})),
	);

	const waiters = createToolResponseWaiters();
	const pending = (await askTool(waiters)).execute("tc-many", many);
	await Promise.resolve();
	const responded = waiters.respond("tc-many", declined);
	expect(responded.handled).toBe(true);
	expect(textOf(await pending)).toContain("declined");
	waiters.persistTurn([persistedResponse("tc-many", declined)]);
	if (responded.handled) await responded.persisted;
});

test("the composed extension keeps the first ask as its batch's only tool call", async () => {
	const { messageEnd } = await composeAsk(createToolResponseWaiters());
	const message = fauxAssistantMessage(
		[
			{ type: "text", text: "I need input." },
			fauxToolCall("read", {}, { id: "read-1" }),
			fauxToolCall("ask_user_question", args(), { id: "ask-1" }),
			fauxToolCall("ask_user_question", args(), { id: "ask-2" }),
		],
		{ stopReason: "toolUse" },
	);
	const isolated = await messageEnd(message);
	if (isolated?.role !== "assistant") throw new Error("expected an isolated assistant message");
	expect(
		isolated.content.map((block) => (block.type === "toolCall" ? block.id : block.type)),
	).toEqual(["text", "ask-1"]);
});

test("a valid live execution is sequential, blocks for its response, and returns the real result", async () => {
	const waiters = createToolResponseWaiters();
	const tool = await askTool(waiters);
	expect(tool.executionMode).toBe("sequential");
	let settled = false;
	const pending = tool.execute("tc-1", args()).then((result) => {
		settled = true;
		return result;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
	expect(waiters.currentInteraction()).toEqual({ toolCallId: "tc-1", needsInput: true });
	expect(waiters.hasRecoverableCall()).toBe(true);

	const responded = waiters.respond("tc-1", luxon);
	expect(responded.handled).toBe(true);
	expect(waiters.currentInteraction()).toEqual({ toolCallId: "tc-1", needsInput: false });
	expect(waiters.hasRecoverableCall()).toBe(true);
	const response = await pending;
	expect(textOf(response)).toContain('"Which library?"="luxon"');
	expect(response.details).toEqual(luxon);
	expect(response.terminate).toBeUndefined();
	waiters.persistTurn([persistedResponse("tc-1", luxon)]);
	if (responded.handled) await responded.persisted;
	expect(waiters.hasRecoverableCall()).toBe(false);
});

test("the waiters are tool-agnostic: any tool result with the call's id persists its response", async () => {
	const waiters = createToolResponseWaiters();
	waiters.expect("tc-generic");
	const pending = waiters.wait("tc-generic", undefined);
	const responded = waiters.respond("tc-generic", { choice: "b" });
	expect(responded.handled).toBe(true);
	expect(await pending).toEqual({ kind: "response", value: { choice: "b" } });
	const persisted: PersistedToolResult = {
		toolCallId: "tc-generic",
		toolName: "custom_tool",
		details: { choice: "b" },
		isError: false,
	};
	waiters.persistTurn([persisted]);
	if (responded.handled) await responded.persisted;
	expect(waiters.currentInteraction()).toBeNull();
});

test("the session services map a superseded wait to a deferred tool response", async () => {
	const waiters = createToolResponseWaiters();
	const services = toolResponseSessionServices(waiters);
	services.expectToolResponse("tc-deferred");
	const pending = services.awaitToolResponse("tc-deferred", undefined);
	expect(waiters.supersede()).toBe(true);
	expect(await pending).toEqual({ kind: "deferred" });
	waiters.persistTurn([]);
});

test("an accepted response is acknowledged by its persisted details, whatever text reached the model", async () => {
	const outcomes: [string, PersistedToolResult, "resolves" | "rejects"][] = [
		["the extension's own envelope", persistedResponse("tc-proof", luxon), "resolves"],
		[
			"content rewritten by a post-tool hook",
			{ ...persistedResponse("tc-proof", luxon), content: [{ type: "text", text: "rewritten" }] },
			"resolves",
		],
		[
			"details replaced by a post-tool hook",
			{ ...persistedResponse("tc-proof", luxon), details: declined },
			"rejects",
		],
		["an error result", { ...persistedResponse("tc-proof", luxon), isError: true }, "rejects"],
	];
	for (const [label, persisted, expected] of outcomes) {
		const waiters = createToolResponseWaiters();
		const pending = (await askTool(waiters)).execute("tc-proof", args());
		await Promise.resolve();
		const responded = waiters.respond("tc-proof", luxon);
		await pending;
		waiters.persistTurn([persisted]);
		if (!responded.handled) throw new Error(label);
		if (expected === "resolves") await responded.persisted;
		else await expect(responded.persisted).rejects.toThrow("accepted response of this tool call");
	}
});

test("a response arriving after tool_execution_start but before execute is retained", async () => {
	const waiters = createToolResponseWaiters();
	waiters.expect("tc-early");
	const responded = waiters.respond("tc-early", luxon);
	expect(responded.handled).toBe(true);
	const response = await (await askTool(waiters)).execute("tc-early", args());
	expect(response.details).toEqual(luxon);
	waiters.persistTurn([persistedResponse("tc-early", luxon)]);
	if (responded.handled) await responded.persisted;
});

test("an early response wins even if Stop reaches the tool before execute starts", async () => {
	const waiters = createToolResponseWaiters();
	const controller = new AbortController();
	waiters.expect("tc-early-stop");
	const responded = waiters.respond("tc-early-stop", luxon);
	controller.abort();
	const response = await (await askTool(waiters)).execute(
		"tc-early-stop",
		args(),
		controller.signal,
	);
	expect(response.details).toEqual(luxon);
	waiters.persistTurn([persistedResponse("tc-early-stop", luxon)]);
	if (responded.handled) await responded.persisted;
});

test("shutdown freezes an expected call before a late response can race its snapshot", () => {
	const waiters = createToolResponseWaiters();
	waiters.expect("tc-shutdown-expected");
	expect(waiters.prepareShutdown()).toBeNull();
	expect(waiters.hasRecoverableCall()).toBe(true);
	expect(() => waiters.respond("tc-shutdown-expected", declined)).toThrow(
		"not awaiting a response",
	);
	expect(() => waiters.respond("restart-repaired", declined)).toThrow("not awaiting a response");
	waiters.abandon();
});

test("shutdown waits for a response already accepted before its snapshot", async () => {
	const waiters = createToolResponseWaiters();
	const pending = (await askTool(waiters)).execute("tc-shutdown-accepted", args(), undefined);
	await Promise.resolve();
	const responded = waiters.respond("tc-shutdown-accepted", declined);
	expect(responded.handled).toBe(true);
	await pending;
	const settling = waiters.prepareShutdown();
	expect(settling).not.toBeNull();
	waiters.persistTurn([persistedResponse("tc-shutdown-accepted", declined)]);
	await settling;
});

test("explicit Stop claims an expected call before execute or a late response can win", async () => {
	const waiters = createToolResponseWaiters();
	waiters.expect("tc-stop-expected");
	expect(waiters.prepareAbort()).toBeNull();
	expect(waiters.currentInteraction()?.needsInput).toBe(false);
	expect(waiters.hasRecoverableCall()).toBe(false);
	await expect(waiters.wait("tc-stop-expected", undefined)).rejects.toThrow(
		TOOL_RESPONSE_STOPPED_ERROR,
	);
	expect(() => waiters.respond("tc-stop-expected", declined)).toThrow("not awaiting a response");
	waiters.persistTurn([]);
});

test("semantic validation failure cannot acknowledge a response accepted before execute", async () => {
	const waiters = createToolResponseWaiters();
	waiters.expect("tc-invalid");
	const responded = waiters.respond("tc-invalid", declined);
	const response = await (await askTool(waiters)).execute(
		"tc-invalid",
		{
			questions: [
				{
					question: "Which library?",
					header: "Library",
					options: [
						{ label: "Other", description: "reserved" },
						{ label: "Built in", description: "valid" },
					],
				},
			],
		},
		undefined,
	);
	expect(textOf(response)).toContain("Option label is reserved");
	waiters.persistTurn([{ toolCallId: "tc-invalid" }]);
	if (responded.handled)
		await expect(responded.persisted).rejects.toThrow("accepted response of this tool call");
});

test("a malformed response accepted before execute fails the tool instead of being persisted", async () => {
	const waiters = createToolResponseWaiters();
	waiters.expect("tc-malformed");
	const responded = waiters.respond("tc-malformed", { choice: "b" });
	expect(responded.handled).toBe(true);
	await expect((await askTool(waiters)).execute("tc-malformed", args())).rejects.toThrow(
		"Malformed ask_user_question response",
	);
	waiters.persistTurn([{ toolCallId: "tc-malformed", isError: true }]);
	if (responded.handled)
		await expect(responded.persisted).rejects.toThrow("accepted response of this tool call");
});

test("turn_end without the returned response rejects persistence instead of hanging", async () => {
	const waiters = createToolResponseWaiters();
	const pending = (await askTool(waiters)).execute("tc-missing-result", args(), undefined);
	await Promise.resolve();
	const responded = waiters.respond("tc-missing-result", declined);
	await pending;
	waiters.persistTurn([]);
	if (responded.handled)
		await expect(responded.persisted).rejects.toThrow("accepted response of this tool call");
});

test("turn_end clears an expected call that Pi never executed", async () => {
	const waiters = createToolResponseWaiters();
	waiters.expect("tc-skipped");
	expect(waiters.currentInteraction()).toEqual({ toolCallId: "tc-skipped", needsInput: true });
	expect(waiters.hasRecoverableCall()).toBe(true);
	const responded = waiters.respond("tc-skipped", declined);
	waiters.persistTurn([]);
	expect(waiters.hasRecoverableCall()).toBe(false);
	if (responded.handled)
		await expect(responded.persisted).rejects.toThrow("accepted response of this tool call");
});

test("abandon rejects an accepted response's uncommitted persistence wait", async () => {
	const waiters = createToolResponseWaiters();
	const pending = (await askTool(waiters)).execute("tc-dispose", args());
	await Promise.resolve();
	const responded = waiters.respond("tc-dispose", declined);
	expect(responded.handled).toBe(true);
	await pending;
	waiters.abandon();
	if (responded.handled)
		await expect(responded.persisted).rejects.toThrow(
			"Session disposed while waiting for a tool response",
		);
});

test("abandon resolves a live wait as abandoned", async () => {
	const waiters = createToolResponseWaiters();
	waiters.expect("tc-abandoned");
	const pending = waiters.wait("tc-abandoned", undefined);
	waiters.abandon();
	expect(await pending).toEqual({ kind: "abandoned" });
	expect(waiters.currentInteraction()).toBeNull();
});

test("an accepted response wins over a later Stop before its result boundary", async () => {
	const waiters = createToolResponseWaiters();
	const controller = new AbortController();
	const pending = (await askTool(waiters)).execute("tc-response-wins", args(), controller.signal);
	await Promise.resolve();
	const responded = waiters.respond("tc-response-wins", luxon);
	controller.abort();
	expect((await pending).details).toEqual(luxon);
	waiters.persistTurn([persistedResponse("tc-response-wins", luxon)]);
	if (responded.handled) await responded.persisted;
});

test("Stop remains terminal until turn_end and rejects a late response", async () => {
	const waiters = createToolResponseWaiters();
	const controller = new AbortController();
	const pending = (await askTool(waiters)).execute("tc-stop-first", args(), controller.signal);
	await Promise.resolve();
	controller.abort();
	expect(() => waiters.respond("tc-stop-first", declined)).toThrow("not awaiting a response");
	await expect(pending).rejects.toThrow(TOOL_RESPONSE_STOPPED_ERROR);
	waiters.persistTurn([{ toolCallId: "tc-stop-first" }]);
});

test("a live waiter rejects with the stable stopped result when Pi aborts", async () => {
	const waiters = createToolResponseWaiters();
	const controller = new AbortController();
	const pending = (await askTool(waiters)).execute("tc-abort", args(), controller.signal);
	await Promise.resolve();
	controller.abort(new Error("provider-specific abort text"));
	await expect(pending).rejects.toThrow(TOOL_RESPONSE_STOPPED_ERROR);
});

test("a duplicate execute of the same interactive call is rejected", async () => {
	const waiters = createToolResponseWaiters();
	waiters.expect("tc-dup");
	const first = waiters.wait("tc-dup", undefined);
	await expect(waiters.wait("tc-dup", undefined)).rejects.toThrow(
		"Duplicate interactive tool call: tc-dup",
	);
	waiters.supersede();
	expect(await first).toEqual({ kind: "superseded" });
	waiters.persistTurn([]);
});

test("a user message typed past a waiting call supersedes it with the extension's own ack", async () => {
	const waiters = createToolResponseWaiters();
	const pending = (await askTool(waiters)).execute("tc-typed-past", args());
	await Promise.resolve();
	expect(waiters.currentInteraction()?.needsInput).toBe(true);
	expect(waiters.supersede()).toBe(true);
	expect(waiters.hasRecoverableCall()).toBe(false);
	expect(waiters.currentInteraction()).toEqual({ toolCallId: "tc-typed-past", needsInput: false });
	const response = await pending;
	expect(textOf(response)).toContain("This turn ends here");
	expect(response.details).toEqual({ kind: "ack" });
	expect(response.terminate).toBe(true);
	expect(() => waiters.respond("tc-typed-past", declined)).toThrow("superseded by a later message");
	expect(waiters.supersede()).toBe(false);
	waiters.persistTurn([{ toolCallId: "tc-typed-past", ...response }]);
	expect(waiters.currentInteraction()).toBeNull();
});

test("a user message typed in the pre-execute window supersedes the expected call", async () => {
	const waiters = createToolResponseWaiters();
	waiters.expect("tc-typed-early");
	expect(waiters.supersede()).toBe(true);
	const response = await (await askTool(waiters)).execute("tc-typed-early", args(), undefined);
	expect(response.details).toEqual({ kind: "ack" });
	waiters.persistTurn([]);
});

test("supersede never reverses a response that was already accepted", async () => {
	const waiters = createToolResponseWaiters();
	const pending = (await askTool(waiters)).execute("tc-responded-first", args(), undefined);
	await Promise.resolve();
	const responded = waiters.respond("tc-responded-first", luxon);
	expect(waiters.supersede()).toBe(false);
	expect((await pending).details).toEqual(luxon);
	waiters.persistTurn([persistedResponse("tc-responded-first", luxon)]);
	if (responded.handled) await responded.persisted;
});

test("supersede leaves a stopped call stopped", async () => {
	const waiters = createToolResponseWaiters();
	waiters.expect("tc-stopped");
	await waiters.prepareAbort();
	expect(waiters.supersede()).toBe(false);
	await expect(waiters.wait("tc-stopped", undefined)).rejects.toThrow(TOOL_RESPONSE_STOPPED_ERROR);
	waiters.persistTurn([]);
});

test("the host's asker answers without pi's own UI, because the chat is the UI", async () => {
	const waiters = createToolResponseWaiters();
	const pending = (await askTool(waiters, { hasUI: false })).execute("tc-no-pi-ui", args());
	await Promise.resolve();
	const responded = waiters.respond("tc-no-pi-ui", declined);
	expect(responded.handled).toBe(true);
	expect(textOf(await pending)).toContain("declined");
	waiters.persistTurn([persistedResponse("tc-no-pi-ui", declined)]);
	if (responded.handled) await responded.persisted;
});

test("execute returns a validation error (non-terminating) for a malformed questionnaire", async () => {
	const r = await run(args([]));
	expect(textOf(r)).toContain("At least one question is required");
	expect(r.details).toMatchObject({ cancelled: true });
	expect(r.terminate).toBeUndefined();
});

test("assessRespondability: a pending, unresponded call is respondable and yields its tool and args", () => {
	const messages = [askCall("tc"), pendingResult("tc")];
	const verdict = assessRespondability(messages, "tc", INTERACTIVE);
	expect(hasPendingToolResult(messages, "tc")).toBe(true);
	expect(verdict).toEqual({ ok: true, toolName: "ask_user_question", args: args() });
	expect(awaitingToolCallId(messages, INTERACTIVE)).toBe("tc");
	expect(awaitingToolCallId(messages, INTERACTIVE, true)).toBe("tc");
});

test("assessRespondability: a call from a non-executable assistant is terminal", () => {
	for (const stopReason of NON_EXECUTABLE_STOP_REASONS) {
		const messages = [askCall("tc-dead", args(), stopReason)];
		expect(assessRespondability(messages, "tc-dead", INTERACTIVE)).toEqual({
			ok: false,
			reason: "not_awaiting",
		});
		expect(awaitingToolCallId(messages, INTERACTIVE)).toBeNull();
	}
});

test("assessRespondability: a call whose tool is not in the interactive map is unknown", () => {
	const foreign = [askCall("tc-foreign"), pendingResult("tc-foreign")];
	expect(assessRespondability(foreign, "tc-foreign", new Map())).toEqual({
		ok: false,
		reason: "unknown_call",
	});
	expect(awaitingToolCallId(foreign, new Map())).toBeNull();

	const generic = [toolCall("tc-bash", "bash", { command: "ls" })];
	expect(assessRespondability(generic, "tc-bash", INTERACTIVE)).toEqual({
		ok: false,
		reason: "unknown_call",
	});
	expect(awaitingToolCallId(generic, INTERACTIVE)).toBeNull();
});

test("assessRespondability: an unknown tool call id is rejected", () => {
	expect(assessRespondability([askCall("tc"), pendingResult("tc")], "nope", INTERACTIVE)).toEqual({
		ok: false,
		reason: "unknown_call",
	});
});

test("assessRespondability: a second response to the same call is rejected", () => {
	const messages = [askCall("tc"), pendingResult("tc"), responseMessage("tc")];
	expect(assessRespondability(messages, "tc", INTERACTIVE)).toEqual({
		ok: false,
		reason: "already_responded",
	});
	expect(awaitingToolCallId(messages, INTERACTIVE)).toBeNull();
});

test("assessRespondability: a legacy ask-user-answers message still counts as the call's response", () => {
	const messages = [askCall("tc"), pendingResult("tc"), legacyAnswersMessage("tc")];
	expect(assessRespondability(messages, "tc", INTERACTIVE)).toEqual({
		ok: false,
		reason: "already_responded",
	});
});

test("assessRespondability: a final tool result (not the pending ack) is not awaiting", () => {
	const messages = [askCall("tc"), finalResult("tc")];
	expect(hasPendingToolResult(messages, "tc")).toBe(false);
	expect(assessRespondability(messages, "tc", INTERACTIVE)).toEqual({
		ok: false,
		reason: "not_awaiting",
	});
});

test("assessRespondability: a later free-form user message supersedes the call", () => {
	const messages = [askCall("tc"), pendingResult("tc"), userMessage()];
	expect(assessRespondability(messages, "tc", INTERACTIVE)).toEqual({
		ok: false,
		reason: "superseded",
	});
	expect(awaitingToolCallId(messages, INTERACTIVE)).toBeNull();
});

test("assessRespondability: a response message for ANOTHER call neither responds nor supersedes", () => {
	const messages = [askCall("tc"), pendingResult("tc"), askCall("tc2"), responseMessage("tc2")];
	expect(assessRespondability(messages, "tc", INTERACTIVE).ok).toBe(true);
});

test("assessRespondability: a tool-response message missing its correlation cannot mark a call responded", () => {
	const noResponse = customMessage({
		customType: TOOL_RESPONSE_CUSTOM_TYPE,
		content: "tag right, shape wrong",
		display: true,
		details: { toolCallId: "tc" },
	});
	const noToolCallId = customMessage({
		customType: TOOL_RESPONSE_CUSTOM_TYPE,
		content: "tag right, shape wrong",
		display: true,
		details: { response: declined },
	});
	for (const malformed of [noResponse, noToolCallId]) {
		expect(
			assessRespondability([askCall("tc"), pendingResult("tc"), malformed], "tc", INTERACTIVE).ok,
		).toBe(true);
	}
});

test("assessRespondability: the tiny pre-ack window (call ended, result not yet) is respondable", () => {
	const messages = [askCall("tc")];
	expect(assessRespondability(messages, "tc", INTERACTIVE).ok).toBe(true);
	expect(awaitingToolCallId(messages, INTERACTIVE)).toBe("tc");
	expect(awaitingToolCallId(messages, INTERACTIVE, true)).toBeNull();
});

test("buildToolResponseMessage carries the described text + the correlated response", () => {
	const msg = buildToolResponseMessage("User has answered your questions: …", "tc-9", luxon);
	expect(msg.customType).toBe(TOOL_RESPONSE_CUSTOM_TYPE);
	expect(msg.customType).toBe("tool-response");
	expect(msg.content).toBe("User has answered your questions: …");
	expect(msg.display).toBe(true);
	expect(msg.details).toEqual({ toolCallId: "tc-9", response: luxon });
});

test("describeToolResponse uses the interactive tool's describeResponse when it has one", () => {
	const described = (args: unknown, response: unknown) =>
		`custom: ${JSON.stringify([args, response])}`;
	const interactive: InteractiveTools = new Map([
		["custom_tool", { describeResponse: described }],
		["bare_tool", {}],
	]);
	expect(describeToolResponse("custom_tool", { a: 1 }, { b: 2 }, interactive)).toBe(
		'custom: [{"a":1},{"b":2}]',
	);
	expect(describeToolResponse("bare_tool", { a: 1 }, { b: 2 }, interactive)).toBe(
		'The user responded to the bare_tool call that was waiting for them:\n{\n  "b": 2\n}',
	);
	expect(describeToolResponse("unknown_tool", {}, "yes", interactive)).toBe(
		'The user responded to the unknown_tool call that was waiting for them:\n"yes"',
	);
});

test("describeToolResponse through the real ask extension renders the questionnaire envelope", () => {
	const interactive = interactiveTools(() => false);
	const answered = describeToolResponse("ask_user_question", args(), luxon, interactive);
	expect(answered).toContain("User has answered your questions");
	expect(answered).toContain('"Which library?"="luxon"');
	expect(describeToolResponse("ask_user_question", args(), declined, interactive)).toBe(
		"User declined to answer questions",
	);
});

test("describeToolResponse falls back to the JSON preface for a foreign-shaped ask response", () => {
	const interactive = interactiveTools(() => false);
	const foreignArgs = { question: "Pick?", choices: ["a", "b"] };
	expect(describeToolResponse("ask_user_question", foreignArgs, luxon, interactive)).toBe(
		`The user responded to the ask_user_question call that was waiting for them:\n${JSON.stringify(luxon, null, 2)}`,
	);
	expect(describeToolResponse("ask_user_question", args(), { choice: "b" }, interactive)).toBe(
		'The user responded to the ask_user_question call that was waiting for them:\n{\n  "choice": "b"\n}',
	);
});

test("RESPONDABILITY_ERRORS spell every rejection reason", () => {
	expect(RESPONDABILITY_ERRORS).toEqual({
		unknown_call: "Unknown tool call awaiting a response",
		already_responded: "This tool call was already responded to",
		not_awaiting: "This tool call is not awaiting a response",
		superseded: "This tool call was superseded by a later message",
	});
});
