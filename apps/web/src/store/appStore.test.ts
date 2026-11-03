import { beforeEach, expect, test } from "bun:test";
import type { SessionId, WorkspaceId } from "@thinkrail/contracts";
import {
	type AppConfig,
	DEFAULT_CONFIG,
	type ExtUiRequest,
	type HostUpdateNotice,
	type PiEvent,
	type Project,
	type SessionEventPayload,
	type SessionStateRecord,
	type SessionSummary,
	type SpecGraphNode,
	type WireModel,
	type Workspace,
	type WorkspaceFsChangedPayload,
	type WorkspaceSkillChange,
} from "@thinkrail/contracts";
import { testProjectId, testSessionId, testWorkspaceId } from "@thinkrail/contracts/test-ids";
import type { HydratedRuntime } from "../chat/hydrate";
import type { ChatTurn, FailureRecovery } from "../chat/types";
import { nullProto, userText } from "../lib";
import {
	BUILTIN_LAYOUT_PRESETS,
	emptyWorkspaceView,
	instantiateWorkbenchFrame,
	projectWorkspaceLayout,
	type WorkspaceLayoutDocument,
} from "../shell/layout";
import {
	captureCenterNavigation,
	chatTabId,
	type FileTab,
	isCenterNavigationCurrent,
	isFileComparison,
	layoutOpenOptionsForNavigation,
	type SessionRuntime,
	shouldAdvanceAcceptedNavigation,
	toast,
	useAppStore,
} from "./appStore";
import {
	selectActiveFilePath,
	selectChatAttended,
	selectCompactionTurnIds,
	selectCurrentRouteChatTarget,
	selectDiffScope,
	selectFilesTreeView,
	selectLastOpenChatSession,
	selectReadyCompletionAck,
	selectSkillsStale,
	selectWorkspaceNavTick,
	selectWorkspaceSessionIds,
	selectWorkspaceTick,
} from "./selectors";

const emptyHydration = (): HydratedRuntime => ({
	turns: [],
	toolResults: {},
	toolResponses: {},
	turnIdByMessageIndex: [],
});
const agentStart = { type: "agent_start" } as unknown as PiEvent;
const agentEnd = { type: "agent_end", willRetry: false, messages: [] } as unknown as PiEvent;
const agentSettled = (terminal: Extract<PiEvent, { type: "agent_settled" }>["terminal"] = null) =>
	({ type: "agent_settled", terminal }) as PiEvent;
const recoveredOverflow: PiEvent = {
	type: "compaction_end",
	reason: "overflow",
	result: undefined,
	aborted: false,
	willRetry: true,
};
const toolStart = (toolCallId: string) =>
	({ type: "tool_execution_start", toolCallId, toolName: "bash" }) as unknown as PiEvent;
const toolUpdate = (toolCallId: string, partialResult: unknown) =>
	({ type: "tool_execution_update", toolCallId, partialResult }) as unknown as PiEvent;
const toolEnd = (toolCallId: string, result: unknown, isError = false) =>
	({ type: "tool_execution_end", toolCallId, result, isError }) as unknown as PiEvent;
const retryStart = (attempt: number, maxAttempts: number, delayMs: number) =>
	({
		type: "auto_retry_start",
		attempt,
		maxAttempts,
		delayMs,
		errorMessage: "rate limit",
	}) as unknown as PiEvent;
const retryEnd = { type: "auto_retry_end", success: true, attempt: 1 } as unknown as PiEvent;
const summarizationScheduled = (
	attempt: number,
	maxAttempts: number,
	delayMs: number,
): PiEvent => ({
	type: "summarization_retry_scheduled",
	attempt,
	maxAttempts,
	delayMs,
	errorMessage: "stream dropped",
});
const summarizationFinished: PiEvent = { type: "summarization_retry_finished" };
const agentEndError = (errorMessage: string) =>
	({
		type: "agent_end",
		willRetry: false,
		messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage }],
	}) as unknown as PiEvent;
const assistantStart = {
	type: "message_start",
	message: { role: "assistant" },
} as unknown as PiEvent;
const userStart = (text: string) =>
	({
		type: "message_start",
		message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
	}) as unknown as PiEvent;
const sessionTitleChanged = (name?: string): PiEvent => ({ type: "session_info_changed", name });
const assistantText = (text: string) =>
	({
		type: "message_update",
		assistantMessageEvent: {
			type: "text",
			partial: { role: "assistant", content: [{ type: "text", text }] },
		},
	}) as unknown as PiEvent;
const emptyBottomRegion = (): WorkspaceLayoutDocument["bottom"] => ({
	visible: false,
	height: 0.3,
	alignment: "center",
	groups: [],
});

function hostNotice(
	availableVersion = "0.2.0",
	status?: HostUpdateNotice["status"],
): HostUpdateNotice {
	return {
		currentVersion: "0.1.0",
		channel: "stable",
		availableVersion,
		...(status ? { status } : {}),
	};
}

beforeEach(() => {
	useAppStore.setState({
		status: "connecting",
		connectionGeneration: 0,
		welcomeGeneration: 0,
		protocolVersion: null,
		hostUpdate: null,
		routeChatTarget: null,
		routeChatTargetGeneration: 0,
		sessions: {},
		sessionStateByWorkspace: {},
		sessionStateClock: 0,
		sessionStateSnapshotInstalled: false,
		renderedCompletionBySession: {},
		obscuredChatSessions: {},
		extUiOrphans: [],
		workbenchFrame: null,
		workspaceViewsByWorkspace: {},
		layoutStateReady: false,
		layoutDocumentsByWorkspace: {},
		layoutAttentionByWorkspace: {},
		layoutProjectionEpoch: 0,
		layoutIntents: [],
		tabsByWorkspace: {},
		terminalsByWorkspace: {},
		activeTerminalByWorkspace: {},
		activeTabByWorkspace: {},
		previewTabByWorkspace: {},
		navTickByWorkspace: {},
		closedChatsByWorkspace: {},
		deletedSessionsByWorkspace: {},
		fsChangesByWorkspace: {},
		skillChangeTickByWorkspace: {},
		skillsSyncedTickBySession: {},
		projects: [],
		recentProjects: [],
		workspaces: {},
		removedWorkspaceIds: {},
		expandedProjectIds: {},
		selectedProjectId: null,
		activeWorkspaceId: null,
		workspaceSelectionHistory: [],
		activeLogin: null,
		settingsOpen: false,
		settingsSection: "providers",
		surveyInvitationOpen: false,
		surveyWindowOpen: false,
		inAppSurvey: null,
		chatLineWidth: DEFAULT_CONFIG.chatLineWidth,
		fileLineWidth: DEFAULT_CONFIG.fileLineWidth,
		chatLineWidthBounded: DEFAULT_CONFIG.chatLineWidthBounded,
		fileLineWidthBounded: DEFAULT_CONFIG.fileLineWidthBounded,
		chatMessageOrder: "oldest-first",
		streamingResponseMovement: { settle: 75, trigger: 100 },
		toasts: [],
	});
});

test("layout projection epoch advances only when projection invalidation is requested", () => {
	const preset = BUILTIN_LAYOUT_PRESETS.find((candidate) => candidate.id === "balanced");
	if (!preset) throw new Error("missing Balanced preset");
	const frame = instantiateWorkbenchFrame(preset);
	const view = emptyWorkspaceView();
	const payload = {
		frame,
		viewsByWorkspace: { workspace: view },
		documentsByWorkspace: { workspace: projectWorkspaceLayout(frame, view) },
		attentionByWorkspace: {},
		preferences: useAppStore.getState().localLayoutPreferences,
	};
	const store = useAppStore.getState();
	store.applyLocalLayoutState(payload);
	expect(useAppStore.getState().layoutProjectionEpoch).toBe(0);
	useAppStore.getState().applyLocalLayoutState(payload, true);
	expect(useAppStore.getState().layoutProjectionEpoch).toBe(1);
	useAppStore.getState().applyLocalLayoutState(payload);
	expect(useAppStore.getState().layoutProjectionEpoch).toBe(1);
});

function rt(sessionId: SessionId): SessionRuntime {
	const runtime = useAppStore.getState().sessions[sessionId];
	if (!runtime) throw new Error(`no runtime for ${sessionId}`);
	return runtime;
}

function failureRecovery(sessionId: SessionId): FailureRecovery | undefined {
	const error = rt(sessionId).turns.find((turn) => turn.kind === "error");
	return error?.kind === "error" ? error.recovery : undefined;
}

test("connection transitions advance reconnect generations and invalidate old protocol capabilities", () => {
	const store = useAppStore.getState();
	store.setStatus("connected");
	store.installWelcomeSnapshot(55, [], []);
	expect(useAppStore.getState()).toMatchObject({
		status: "connected",
		connectionGeneration: 1,
		protocolVersion: 55,
	});
	store.setStatus("disconnected");
	expect(useAppStore.getState()).toMatchObject({
		status: "disconnected",
		connectionGeneration: 1,
		protocolVersion: null,
	});
	store.setStatus("connecting");
	store.setStatus("connected");
	expect(useAppStore.getState()).toMatchObject({
		status: "connected",
		connectionGeneration: 2,
		protocolVersion: null,
	});
	store.installWelcomeSnapshot(54, [], []);
	expect(useAppStore.getState().protocolVersion).toBe(54);
});

test("selectLastOpenChatSession: active chat tab first, then the most recent chat tab, else null", () => {
	const store = useAppStore.getState();
	expect(selectLastOpenChatSession(useAppStore.getState(), testWorkspaceId("ws1"))).toBeNull();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("s1"), null, "medium");
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("s2"), null, "medium");
	expect(selectLastOpenChatSession(useAppStore.getState(), testWorkspaceId("ws1"))).toBe(
		testSessionId("s2"),
	);
	useAppStore.getState().openTab(fileTab(testWorkspaceId("ws1"), "a.ts"), "keep");
	expect(selectLastOpenChatSession(useAppStore.getState(), testWorkspaceId("ws1"))).toBe(
		testSessionId("s2"),
	);
});

test("pi events route to the right session runtime; chats stay independent", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("b"), null, "high");

	store.handlePiEvent(agentStart, testSessionId("a"));
	store.handlePiEvent(toolStart("t1"), testSessionId("a"));
	expect(rt(testSessionId("a")).isStreaming).toBe(true);
	expect(rt(testSessionId("a")).toolResults.t1?.status).toBe("running");
	expect(rt(testSessionId("b")).isStreaming).toBe(false);
	expect(Object.keys(rt(testSessionId("b")).toolResults)).toHaveLength(0);

	store.handlePiEvent(agentStart, testSessionId("b"));
	expect(rt(testSessionId("a")).isStreaming).toBe(true);
	expect(rt(testSessionId("b")).isStreaming).toBe(true);

	store.handlePiEvent(agentEnd, testSessionId("a"));
	expect(rt(testSessionId("a")).isStreaming).toBe(true);
	expect(
		rt(testSessionId("a")).turns.some((t) => t.kind === "system" && t.text === undefined),
	).toBe(false);
	store.handlePiEvent(agentSettled(), testSessionId("a"));
	expect(rt(testSessionId("a")).isStreaming).toBe(false);
	expect(
		rt(testSessionId("a")).turns.some((t) => t.kind === "system" && t.text === undefined),
	).toBe(true);
	expect(rt(testSessionId("b")).isStreaming).toBe(true);
	expect(rt(testSessionId("b")).turns).toHaveLength(0);
});

test("an ordered Pi-event batch commits once while preserving every session revision", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("b"), null, "high");
	const partial = { content: [{ type: "text", text: "partial" }] };
	const payloads: SessionEventPayload[] = [
		{ sessionId: testSessionId("a"), event: agentStart },
		{ sessionId: testSessionId("a"), event: toolStart("t1") },
		{ sessionId: testSessionId("b"), event: agentStart },
		{ sessionId: testSessionId("a"), event: toolUpdate("t1", partial) },
		{ sessionId: testSessionId("a"), event: agentEnd },
		{ sessionId: testSessionId("missing"), event: agentStart },
	];
	let commits = 0;
	const unsubscribe = useAppStore.subscribe(() => {
		commits += 1;
	});

	store.handlePiEvents(payloads);
	unsubscribe();

	expect(commits).toBe(1);
	expect(rt(testSessionId("a")).eventRevision).toBe(4);
	expect(rt(testSessionId("a")).isStreaming).toBe(true);
	expect(rt(testSessionId("a")).toolResults.t1).toEqual({ status: "running", raw: partial });
	expect(rt(testSessionId("b")).eventRevision).toBe(1);
	expect(rt(testSessionId("b")).isStreaming).toBe(true);
});

test("a settlement tick survives a batched false-to-false streaming endpoint", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	expect(rt(testSessionId("a")).settlementTick).toBe(0);
	let commits = 0;
	const unsubscribe = useAppStore.subscribe(() => {
		commits += 1;
	});

	store.handlePiEvents([
		{ sessionId: testSessionId("a"), event: agentStart },
		{ sessionId: testSessionId("a"), event: agentEnd },
		{ sessionId: testSessionId("a"), event: agentSettled() },
	]);
	unsubscribe();

	expect(commits).toBe(1);
	expect(rt(testSessionId("a")).isStreaming).toBe(false);
	expect(rt(testSessionId("a")).settlementTick).toBe(1);
	store.handlePiEvent(agentEnd, testSessionId("a"));
	expect(rt(testSessionId("a")).settlementTick).toBe(1);
	store.handlePiEvent(agentSettled(), testSessionId("a"));
	expect(rt(testSessionId("a")).settlementTick).toBe(2);
});

test("stats refresh ticks survive batching at finalized Pi state boundaries", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	let commits = 0;
	const unsubscribe = useAppStore.subscribe(() => {
		commits += 1;
	});

	store.handlePiEvents([
		{ sessionId: testSessionId("a"), event: agentStart },
		{ sessionId: testSessionId("a"), event: assistantStart },
		{ sessionId: testSessionId("a"), event: assistantText("streaming") },
		{
			sessionId: testSessionId("a"),
			event: {
				type: "message_end",
				message: { role: "toolResult" },
			} as unknown as PiEvent,
		},
		{ sessionId: testSessionId("a"), event: { type: "compaction_start", reason: "manual" } },
		{
			sessionId: testSessionId("a"),
			event: {
				type: "compaction_end",
				reason: "manual",
				result: { tokensBefore: 1_000, estimatedTokensAfter: 200 },
				aborted: false,
				willRetry: false,
			},
		},
		{ sessionId: testSessionId("a"), event: agentEnd },
		{ sessionId: testSessionId("a"), event: agentSettled() },
	]);
	unsubscribe();

	expect(commits).toBe(1);
	expect(rt(testSessionId("a")).statsRefreshTick).toBe(3);
	store.handlePiEvent(toolEnd("t1", {}), testSessionId("a"));
	expect(rt(testSessionId("a")).statsRefreshTick).toBe(3);
	store.handlePiEvent({ type: "entry_appended", entryType: "custom" }, testSessionId("a"));
	expect(rt(testSessionId("a")).statsRefreshTick).toBe(3);
	for (const [index, entryType] of [
		"usage",
		"compaction",
		"branch_summary",
		"context_edit",
	].entries()) {
		store.handlePiEvent({ type: "entry_appended", entryType }, testSessionId("a"));
		expect(rt(testSessionId("a")).statsRefreshTick).toBe(4 + index);
	}
});

test("a host-fired USER message folds into the transcript; the composer's optimistic twin doesn't duplicate", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(userStart("<review pkg>"), testSessionId("a"));
	expect(rt(testSessionId("a")).turns).toHaveLength(1);
	expect(rt(testSessionId("a")).turns[0]?.kind).toBe("user");

	store.appendUserMessage(testSessionId("a"), "fix the tests");
	store.handlePiEvent(userStart("fix the tests"), testSessionId("a"));
	expect(rt(testSessionId("a")).turns.filter((t) => t.kind === "user")).toHaveLength(2);

	store.handlePiEvent(userStart("[thinkrail:todo-nudge] plan changed"), testSessionId("a"));
	expect(rt(testSessionId("a")).turns.filter((t) => t.kind === "user")).toHaveLength(2);
});

test("a matching user echo adopts the host clock while retaining optimistic identity and attachment labels", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("clock"), null, "medium");
	store.appendUserMessage(testSessionId("clock"), "fix the tests", [
		{ name: "screen.png", content: { type: "image", data: "test", mimeType: "image/png" } },
	]);
	const optimistic = rt(testSessionId("clock")).turns[0];
	if (optimistic?.kind !== "user") throw new Error("optimistic turn missing");
	const message = {
		role: "user" as const,
		content: [{ type: "text" as const, text: "fix the tests" }],
		timestamp: 1_000,
	};
	store.handlePiEvent({ type: "message_start", message }, testSessionId("clock"));
	expect(rt(testSessionId("clock")).turns).toEqual([{ ...optimistic, message }]);
	expect(rt(testSessionId("clock")).turns[0]).toMatchObject({ attachmentNames: ["screen.png"] });
});

test("queue_update folds pi's queue into the runtime; the canonical echo lands the turn at its true position", () => {
	const queueUpdate = (steering: string[], followUp: string[], hasImages = false) =>
		({
			type: "queue_update",
			steering,
			followUp,
			...(hasImages ? { hasImages: true } : {}),
		}) as unknown as PiEvent;
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	store.handlePiEvent(agentStart, testSessionId("a"));
	store.handlePiEvent(assistantStart, testSessionId("a"));
	store.handlePiEvent(assistantText("first reply"), testSessionId("a"));

	store.handlePiEvent(
		queueUpdate(["course-correct"], ["queued question"], true),
		testSessionId("a"),
	);
	expect(rt(testSessionId("a")).queue).toEqual({
		steering: ["course-correct"],
		followUp: ["queued question"],
		hasImages: true,
	});
	expect(rt(testSessionId("a")).turns.filter((t) => t.kind === "user")).toHaveLength(0);

	store.handlePiEvent(queueUpdate([], ["queued question"]), testSessionId("a"));
	store.handlePiEvent(userStart("course-correct"), testSessionId("a"));
	store.handlePiEvent(queueUpdate([], []), testSessionId("a"));
	store.handlePiEvent(userStart("queued question"), testSessionId("a"));

	const turns = rt(testSessionId("a")).turns;
	expect(turns.map((t) => t.kind)).toEqual(["assistant", "user", "user"]);
	expect(rt(testSessionId("a")).queue).toEqual({ steering: [], followUp: [] });
});

test("normalized session snapshots and pushes gate acknowledgement on the exact rendered result", () => {
	const record = (completionId: string): SessionStateRecord => ({
		sessionId: testSessionId("state-session"),
		workspaceId: testWorkspaceId("state-workspace"),
		projectId: testProjectId("state-project"),
		state: {
			execution: "idle",
			runId: "run",
			needsInput: null,
			completion: { completionId, outcome: "succeeded" },
			completionUnread: true,
			queuedCount: 0,
			backgroundWork: false,
		},
	});
	const ready = () =>
		selectReadyCompletionAck(
			useAppStore.getState(),
			testWorkspaceId("state-workspace"),
			testSessionId("state-session"),
		);
	const store = useAppStore.getState();
	store.setStatus("connected");
	store.openChatSession(
		testWorkspaceId("state-workspace"),
		testSessionId("state-session"),
		null,
		"medium",
	);
	store.installSessionStateSnapshot([record("completion:one")]);
	expect(useAppStore.getState().sessions["state-session"]?.hostState).toEqual(
		record("completion:one").state,
	);
	expect(ready()).toBeNull();
	store.noteRenderedCompletion(testSessionId("state-session"), "completion:one");
	expect(ready()).toBe("completion:one");

	store.applySessionState(record("completion:two"));
	expect(ready()).toBeNull();
	store.noteRenderedCompletion(testSessionId("state-session"), "completion:one");
	expect(ready()).toBeNull();
	store.noteRenderedCompletion(testSessionId("state-session"), "completion:two");
	expect(ready()).toBe("completion:two");

	store.setStatus("disconnected");
	store.setStatus("connected");
	expect(ready()).toBeNull();

	store.deleteChat(testWorkspaceId("state-workspace"), testSessionId("state-session"));
	expect(
		useAppStore.getState().sessionStateByWorkspace["state-workspace"]?.["state-session"],
	).toBeUndefined();
	expect(ready()).toBeNull();
});

test("hydrateSession seeds the queue from the summary snapshot", () => {
	const store = useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws1") });
	const summary: SessionSummary = {
		sessionId: testSessionId("q1"),
		workspaceId: testWorkspaceId("ws1"),
		title: "Chat",
		model: null,
		thinkingLevel: "medium",
		isStreaming: true,
		messageCount: 1,
		updatedAt: 0,
		live: true,
		queue: { steering: [], followUp: ["waiting in line"] },
	};
	store.hydrateSession(summary, emptyHydration());
	expect(rt(testSessionId("q1")).queue).toEqual({ steering: [], followUp: ["waiting in line"] });

	const { queue, ...bare } = summary;
	void queue;
	store.hydrateSession({ ...bare, sessionId: testSessionId("q2") }, emptyHydration());
	expect(rt(testSessionId("q2")).queue).toEqual({ steering: [], followUp: [] });
});

test("Pi's expanded skill echo replaces its matching optimistic slash command in place", () => {
	const expanded =
		'<skill name="review" location="/repo/.pi/skills/review/SKILL.md">\nReferences are relative to /repo/.pi/skills/review.\n\n# Review\n\nInspect the diff.\n</skill>\n\nFocus on src/app.ts.';
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("skill"), null, "medium");
	store.appendUserMessage(testSessionId("skill"), "/skill:review Focus on src/app.ts.");
	const optimistic = rt(testSessionId("skill")).turns[0];
	if (optimistic?.kind !== "user") throw new Error("optimistic turn missing");

	store.handlePiEvent(userStart(expanded), testSessionId("skill"));
	const turns = rt(testSessionId("skill")).turns;
	expect(turns).toHaveLength(1);
	const canonical = turns[0];
	expect(canonical?.id).toBe(optimistic.id);
	expect(canonical?.kind === "user" && userText(canonical.message.content)).toBe(expanded);

	store.openChatSession(testWorkspaceId("ws1"), testSessionId("mismatch"), null, "medium");
	store.appendUserMessage(testSessionId("mismatch"), "/skill:other Focus on src/app.ts.");
	store.handlePiEvent(userStart(expanded), testSessionId("mismatch"));
	expect(rt(testSessionId("mismatch")).turns.filter((turn) => turn.kind === "user")).toHaveLength(
		2,
	);
});

test("an assistant turn is built (and replaced, not duplicated) from message_update partials", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, testSessionId("a"));
	store.handlePiEvent(assistantStart, testSessionId("a"));
	store.handlePiEvent(assistantText("po"), testSessionId("a"));
	store.handlePiEvent(assistantText("pong"), testSessionId("a"));

	const assistants = rt(testSessionId("a")).turns.filter((t) => t.kind === "assistant");
	expect(assistants).toHaveLength(1);
	const turn = assistants[0];
	expect(turn?.kind === "assistant" && turn.streaming).toBe(true);
	expect(turn?.kind === "assistant" && turn.message.content[0]?.type === "text").toBe(true);

	store.handlePiEvent(agentEnd, testSessionId("a"));
	expect(rt(testSessionId("a")).isStreaming).toBe(true);
	store.handlePiEvent(agentSettled(), testSessionId("a"));
	const after = rt(testSessionId("a"));
	expect(after.isStreaming).toBe(false);
	expect(after.currentAssistantId).toBeNull();
	expect(after.turns.some((t) => t.kind === "system" && t.text === undefined)).toBe(true);
});

test("a multi-message turn leaves no assistant turn flagged streaming (no stray live indicator)", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, testSessionId("a"));
	store.handlePiEvent(assistantStart, testSessionId("a"));
	store.handlePiEvent(assistantText("first"), testSessionId("a"));
	store.handlePiEvent(assistantStart, testSessionId("a"));
	expect(
		rt(testSessionId("a")).turns.filter((t) => t.kind === "assistant" && t.streaming),
	).toHaveLength(0);
	store.handlePiEvent(assistantText("second"), testSessionId("a"));
	const streamingMid = rt(testSessionId("a")).turns.filter(
		(t) => t.kind === "assistant" && t.streaming,
	);
	expect(streamingMid).toHaveLength(1);

	store.handlePiEvent(agentEnd, testSessionId("a"));
	expect(rt(testSessionId("a")).turns.some((t) => t.kind === "assistant" && t.streaming)).toBe(
		true,
	);
	store.handlePiEvent(agentSettled(), testSessionId("a"));
	const after = rt(testSessionId("a"));
	expect(after.turns.filter((t) => t.kind === "assistant")).toHaveLength(2);
	expect(after.turns.some((t) => t.kind === "assistant" && t.streaming)).toBe(false);
	expect(after.isStreaming).toBe(false);
});

test("message_end finalizes the turn the moment its message completes (not at agent_end)", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, testSessionId("a"));
	store.handlePiEvent(assistantStart, testSessionId("a"));
	store.handlePiEvent(assistantText("asking…"), testSessionId("a"));
	expect(rt(testSessionId("a")).turns.some((t) => t.kind === "assistant" && t.streaming)).toBe(
		true,
	);

	const finalMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "ask1", name: "ask_user_question", arguments: {} }],
		stopReason: "toolUse",
	};
	store.handlePiEvent(
		{ type: "message_end", message: finalMessage } as unknown as PiEvent,
		testSessionId("a"),
	);

	const after = rt(testSessionId("a"));
	expect(after.isStreaming).toBe(true);
	expect(after.currentAssistantId).toBeNull();
	const turn = after.turns.find((t) => t.kind === "assistant");
	expect(turn?.kind === "assistant" && turn.streaming).toBe(false);
	expect(turn?.kind === "assistant" && turn.message.stopReason).toBe("toolUse");

	const before = rt(testSessionId("a"));
	store.handlePiEvent(
		{ type: "message_end", message: { role: "toolResult" } } as unknown as PiEvent,
		testSessionId("a"),
	);
	const ignored = rt(testSessionId("a"));
	expect(ignored.turns).toBe(before.turns);
	expect(ignored.eventRevision).toBe(before.eventRevision + 1);
});

test("a tool-response custom message_end indexes into toolResponses (never the turn list)", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	const response = { answers: [{ questionIndex: 0, question: "Q?", kind: "text", answer: "A" }] };
	store.handlePiEvent(
		{
			type: "message_end",
			message: {
				role: "custom",
				customType: "tool-response",
				content: "User has answered your questions: …",
				display: true,
				details: { toolCallId: "ask1", response },
			},
		} as unknown as PiEvent,
		testSessionId("a"),
	);
	expect(rt(testSessionId("a")).toolResponses.ask1).toEqual(response);
	expect(
		rt(testSessionId("a")).turns.filter((t) => t.kind === "assistant" || t.kind === "user"),
	).toHaveLength(0);

	// The response value is opaque to the store — whatever the tool's extension chose rides through.
	store.handlePiEvent(
		{
			type: "message_end",
			message: {
				role: "custom",
				customType: "tool-response",
				content: "free text",
				display: true,
				details: { toolCallId: "ask2", response: "free text" },
			},
		} as unknown as PiEvent,
		testSessionId("a"),
	);
	expect(rt(testSessionId("a")).toolResponses).toEqual({ ask1: response, ask2: "free text" });

	const before = rt(testSessionId("a"));
	store.handlePiEvent(
		{
			type: "message_end",
			message: { role: "custom", customType: "other", content: "x", display: false },
		} as unknown as PiEvent,
		testSessionId("a"),
	);
	const ignored = rt(testSessionId("a"));
	expect(ignored.turns).toBe(before.turns);
	expect(ignored.toolResponses).toBe(before.toolResponses);
	expect(ignored.eventRevision).toBe(before.eventRevision + 1);
});

test("a legacy ask-user-answers custom message_end (details.result) indexes into toolResponses too", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	const result = {
		answers: [{ questionIndex: 0, question: "Q?", kind: "option", answer: "A" }],
		cancelled: false,
	};
	store.handlePiEvent(
		{
			type: "message_end",
			message: {
				role: "custom",
				customType: "ask-user-answers",
				content: "User has answered your questions: …",
				display: true,
				details: { toolCallId: "ask1", result },
			},
		} as unknown as PiEvent,
		testSessionId("a"),
	);
	expect(rt(testSessionId("a")).toolResponses.ask1).toEqual(result);
	expect(
		rt(testSessionId("a")).turns.filter((t) => t.kind === "assistant" || t.kind === "user"),
	).toHaveLength(0);
});

test("a subagent-completion custom message_end appends a subagentCompletion turn", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	const details = {
		childSessionId: testSessionId("child-1"),
		roleName: "scout",
		task: "map the repo",
		status: "completed",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.01,
			turns: 3,
			contextTokens: 15,
		},
		durationMs: 4200,
	};
	store.handlePiEvent(
		{
			type: "message_end",
			message: {
				role: "custom",
				customType: "subagent-completion",
				content: 'Subagent "scout" (child-1) completed:\n\nthe report',
				display: true,
				details,
				timestamp: 4_200,
			},
		} as unknown as PiEvent,
		testSessionId("a"),
	);
	const turn = rt(testSessionId("a")).turns.at(-1);
	expect(turn?.kind).toBe("subagentCompletion");
	expect(turn?.kind === "subagentCompletion" && turn.details.childSessionId).toBe("child-1");
	expect(turn?.kind === "subagentCompletion" && turn.text).toContain("the report");
	expect(turn?.kind === "subagentCompletion" && turn.timestamp).toBe(4_200);

	const before = rt(testSessionId("a"));
	store.handlePiEvent(
		{
			type: "message_end",
			message: {
				role: "custom",
				customType: "subagent-completion",
				content: "x",
				display: true,
				details: { nope: true },
			},
		} as unknown as PiEvent,
		testSessionId("a"),
	);
	const ignored = rt(testSessionId("a"));
	expect(ignored.turns).toBe(before.turns);
	expect(ignored.eventRevision).toBe(before.eventRevision + 1);
});

test("a todo-review-fix custom message_end appends a reviewFix turn", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	const details = {
		itemId: "t_1",
		itemTitle: "Wire the login redirect",
		reviewId: "rev_1",
		note: "Two findings below.",
		comments: [{ id: "c_1", kind: "inline", body: "off-by-one", path: "src/a.ts", startLine: 4 }],
	};
	store.handlePiEvent(
		{
			type: "message_end",
			message: {
				role: "custom",
				customType: "todo-review-fix",
				content: "Address each review comment above.",
				display: true,
				details,
			},
		} as unknown as PiEvent,
		testSessionId("a"),
	);
	const turn = rt(testSessionId("a")).turns.at(-1);
	expect(turn?.kind).toBe("reviewFix");
	expect(turn?.kind === "reviewFix" && turn.details.itemId).toBe("t_1");
	expect(turn?.kind === "reviewFix" && turn.details.comments[0]?.id).toBe("c_1");
	expect(turn?.kind === "reviewFix" && turn.text).toContain("Address each review comment");

	const reviewBefore = rt(testSessionId("a"));
	store.handlePiEvent(
		{
			type: "message_end",
			message: {
				role: "custom",
				customType: "todo-review-fix",
				content: "x",
				display: true,
				details: { itemId: "t_1" },
			},
		} as unknown as PiEvent,
		testSessionId("a"),
	);
	const reviewIgnored = rt(testSessionId("a"));
	expect(reviewIgnored.turns).toBe(reviewBefore.turns);
	expect(reviewIgnored.eventRevision).toBe(reviewBefore.eventRevision + 1);
});

test("the tool lifecycle folds into toolResults (the status + raw the renderers read)", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(toolStart("t1"), testSessionId("a"));
	expect(rt(testSessionId("a")).toolResults.t1).toEqual({ status: "running", raw: undefined });

	const partial = { content: [{ type: "text", text: "partial" }] };
	store.handlePiEvent(toolUpdate("t1", partial), testSessionId("a"));
	expect(rt(testSessionId("a")).toolResults.t1).toEqual({ status: "running", raw: partial });

	const final = { content: [{ type: "text", text: "done" }] };
	store.handlePiEvent(toolEnd("t1", final), testSessionId("a"));
	expect(rt(testSessionId("a")).toolResults.t1).toEqual({ status: "done", raw: final });
});

test("a failed tool ends in the error status (the red-path the renderers branch on)", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(toolStart("t1"), testSessionId("a"));
	const errResult = { content: [{ type: "text", text: "boom" }] };
	store.handlePiEvent(toolEnd("t1", errResult, true), testSessionId("a"));
	expect(rt(testSessionId("a")).toolResults.t1).toEqual({ status: "error", raw: errResult });
});

test("auto-retry adds a countdown turn, and resolving it clears the indicator", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(retryStart(2, 3, 5_000), testSessionId("a"));
	const retry = rt(testSessionId("a")).turns.find((t) => t.kind === "retry");
	expect(retry?.kind === "retry" && retry.source).toBe("turn");
	expect(retry?.kind === "retry" && retry.attempt).toBe(2);
	expect(retry?.kind === "retry" && retry.maxAttempts).toBe(3);
	expect(retry?.kind === "retry" && retry.delayMs).toBe(5_000);

	store.handlePiEvent(retryEnd, testSessionId("a"));
	expect(rt(testSessionId("a")).turns.some((t) => t.kind === "retry")).toBe(false);
});

test("summarization retries show their own countdown; re-scheduling replaces, finished clears", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(summarizationScheduled(1, 3, 2_000), testSessionId("a"));
	const first = rt(testSessionId("a")).turns.find((t) => t.kind === "retry");
	expect(first?.kind === "retry" && first.source).toBe("summarization");
	expect(first?.kind === "retry" && first.attempt).toBe(1);

	store.handlePiEvent(summarizationScheduled(2, 3, 4_000), testSessionId("a"));
	const retries = rt(testSessionId("a")).turns.filter((t) => t.kind === "retry");
	expect(retries.length).toBe(1);
	expect(retries[0]?.kind === "retry" && retries[0].attempt).toBe(2);

	store.handlePiEvent(summarizationFinished, testSessionId("a"));
	expect(rt(testSessionId("a")).turns.some((t) => t.kind === "retry")).toBe(false);
});

test("overlapping turn + summarization retries never clear each other", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(retryStart(1, 3, 1_000), testSessionId("a"));
	store.handlePiEvent(summarizationScheduled(1, 3, 2_000), testSessionId("a"));
	expect(rt(testSessionId("a")).turns.filter((t) => t.kind === "retry").length).toBe(2);

	store.handlePiEvent(retryEnd, testSessionId("a"));
	const left = rt(testSessionId("a")).turns.filter((t) => t.kind === "retry");
	expect(left.length).toBe(1);
	expect(left[0]?.kind === "retry" && left[0].source).toBe("summarization");

	store.handlePiEvent(summarizationFinished, testSessionId("a"));
	expect(rt(testSessionId("a")).turns.some((t) => t.kind === "retry")).toBe(false);
});

test("a lingering retry countdown is swept up only when the run settles", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, testSessionId("a"));
	store.handlePiEvent(retryStart(1, 3, 1_000), testSessionId("a"));
	store.handlePiEvent(agentEnd, testSessionId("a"));
	expect(rt(testSessionId("a")).turns.some((t) => t.kind === "retry")).toBe(true);
	store.handlePiEvent(agentSettled(), testSessionId("a"));
	expect(rt(testSessionId("a")).turns.some((t) => t.kind === "retry")).toBe(false);
	expect(
		rt(testSessionId("a")).turns.some((t) => t.kind === "system" && t.text === undefined),
	).toBe(true);
});

test("auto-retry drops the failed attempt's turn — the retried message must not render twice", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, testSessionId("a"));
	store.handlePiEvent(assistantStart, testSessionId("a"));
	store.handlePiEvent(assistantText("The answer is"), testSessionId("a"));
	store.handlePiEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "The answer is" }],
				stopReason: "error",
				errorMessage: "fetch failed",
			},
		} as unknown as PiEvent,
		testSessionId("a"),
	);
	store.handlePiEvent(
		{ type: "agent_end", willRetry: true, messages: [] } as unknown as PiEvent,
		testSessionId("a"),
	);
	store.handlePiEvent(retryStart(1, 3, 2_000), testSessionId("a"));
	expect(rt(testSessionId("a")).turns.some((t) => t.kind === "retry")).toBe(true);

	store.handlePiEvent(agentStart, testSessionId("a"));
	store.handlePiEvent(assistantStart, testSessionId("a"));
	store.handlePiEvent(assistantText("The answer is 4"), testSessionId("a"));
	store.handlePiEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "The answer is 4" }],
				stopReason: "stop",
			},
		} as unknown as PiEvent,
		testSessionId("a"),
	);
	store.handlePiEvent(agentEnd, testSessionId("a"));
	store.handlePiEvent(agentSettled(), testSessionId("a"));

	const after = rt(testSessionId("a"));
	const assistants = after.turns.filter((t) => t.kind === "assistant");
	expect(assistants).toHaveLength(1);
	expect(
		assistants[0]?.kind === "assistant" &&
			assistants[0].message.content.some((c) => c.type === "text" && c.text === "The answer is 4"),
	).toBe(true);
	expect(after.turns.some((t) => t.kind === "retry")).toBe(false);
	expect(after.turns.some((t) => t.kind === "system" && t.text === undefined)).toBe(true);
});

test("auto-retry with no assistant message yet (error before message_start) drops nothing", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	store.appendUserMessage(testSessionId("a"), "hi");

	store.handlePiEvent(agentStart, testSessionId("a"));
	store.handlePiEvent(
		{ type: "agent_end", willRetry: true, messages: [] } as unknown as PiEvent,
		testSessionId("a"),
	);
	store.handlePiEvent(retryStart(1, 3, 2_000), testSessionId("a"));
	expect(rt(testSessionId("a")).turns.filter((t) => t.kind === "user")).toHaveLength(1);
	expect(rt(testSessionId("a")).turns.some((t) => t.kind === "retry")).toBe(true);
});

test("a turn that ends in a provider error surfaces the error (not a false ✓ Done)", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, testSessionId("a"));
	store.handlePiEvent(agentEndError("model 'gpt-5.5' not found"), testSessionId("a"));
	expect(rt(testSessionId("a")).isStreaming).toBe(true);
	store.handlePiEvent(
		agentSettled({ stopReason: "error", errorMessage: "model 'gpt-5.5' not found" }),
		testSessionId("a"),
	);

	const after = rt(testSessionId("a"));
	expect(after.isStreaming).toBe(false);
	const err = after.turns.find((t) => t.kind === "error");
	expect(err?.kind === "error" && err.text).toContain("gpt-5.5");
	expect(failureRecovery(testSessionId("a"))).toBe("try-again");
	expect(after.turns.some((t) => t.kind === "system" && t.text === undefined)).toBe(false);
});

test("a run's closer lands before a mid-run result that woke nobody, as hydration orders it", () => {
	const store = useAppStore.getState();
	const stopped = {
		type: "message_end",
		message: {
			role: "custom",
			customType: "background-command-completion",
			content: "Cancelled background command",
			display: true,
			timestamp: 3,
			details: {
				id: "bg-1",
				sessionId: testSessionId("a"),
				name: "e2e",
				status: "stopped",
				startedAt: 1,
				finishedAt: 3,
				exitCode: null,
				output: { text: "", truncated: false },
			},
		},
	} as unknown as PiEvent;
	for (const [terminal, closer] of [
		[{ stopReason: "error", errorMessage: "provider overloaded" }, "error"],
		[null, "system"],
	] as const) {
		store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
		store.handlePiEvent(agentStart, testSessionId("a"));
		store.handlePiEvent(stopped, testSessionId("a"));
		store.handlePiEvent(agentEnd, testSessionId("a"));
		store.handlePiEvent(agentSettled(terminal), testSessionId("a"));
		expect(
			rt(testSessionId("a"))
				.turns.map((turn) => turn.kind)
				.slice(-2),
		).toEqual([closer, "backgroundCommandCompletion"]);
		store.closeChatRuntime(testSessionId("a"));
	}
});

test("a terminal length stop is a visible failure, never a false ✓ Done", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, testSessionId("a"));
	store.handlePiEvent(agentEnd, testSessionId("a"));
	store.handlePiEvent(agentSettled({ stopReason: "length" }), testSessionId("a"));

	const after = rt(testSessionId("a"));
	const error = after.turns.find((turn) => turn.kind === "error");
	expect(error?.kind === "error" && error.failure).toBe("truncated");
	expect(failureRecovery(testSessionId("a"))).toBe("try-again");
	expect(after.turns.some((turn) => turn.kind === "system" && turn.text === undefined)).toBe(false);
	expect(after.isStreaming).toBe(false);
});

test("a local follow-on consumes only its session's failure recovery", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("b"), null, "medium");
	for (const sessionId of ["a", "b"]) {
		store.handlePiEvent(
			agentSettled({ stopReason: "error", errorMessage: "fetch failed" }),
			testSessionId(sessionId),
		);
	}

	store.appendUserMessage(testSessionId("a"), "Try again.");

	expect(failureRecovery(testSessionId("a"))).toBeUndefined();
	expect(failureRecovery(testSessionId("b"))).toBe("try-again");
});

test("another client's agent start consumes only its session's failure recovery", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("b"), null, "medium");
	for (const sessionId of ["a", "b"]) {
		store.handlePiEvent(
			agentSettled({ stopReason: "error", errorMessage: "fetch failed" }),
			testSessionId(sessionId),
		);
	}

	store.handlePiEvent(agentStart, testSessionId("b"));

	expect(failureRecovery(testSessionId("a"))).toBe("try-again");
	expect(failureRecovery(testSessionId("b"))).toBeUndefined();
});

test("a successful overflow compaction removes the superseded assistant attempt", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, testSessionId("a"));
	store.handlePiEvent(assistantStart, testSessionId("a"));
	store.handlePiEvent(assistantText("incomplete"), testSessionId("a"));
	store.handlePiEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "incomplete" }],
				stopReason: "length",
			},
		} as unknown as PiEvent,
		testSessionId("a"),
	);
	store.handlePiEvent(agentEnd, testSessionId("a"));
	expect(rt(testSessionId("a")).turns.filter((turn) => turn.kind === "assistant")).toHaveLength(1);

	store.handlePiEvent(recoveredOverflow, testSessionId("a"));
	expect(rt(testSessionId("a")).turns.filter((turn) => turn.kind === "assistant")).toHaveLength(0);
	expect(rt(testSessionId("a")).isStreaming).toBe(true);
});

test("overflow recovery never removes an older failure when this attempt was not observed", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, testSessionId("a"));
	store.handlePiEvent(assistantStart, testSessionId("a"));
	store.handlePiEvent(assistantText("old failed answer"), testSessionId("a"));
	store.handlePiEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "old failed answer" }],
				stopReason: "error",
				errorMessage: "old failure",
			},
		} as unknown as PiEvent,
		testSessionId("a"),
	);
	store.handlePiEvent(agentEndError("old failure"), testSessionId("a"));
	store.handlePiEvent(
		agentSettled({ stopReason: "error", errorMessage: "old failure" }),
		testSessionId("a"),
	);
	expect(rt(testSessionId("a")).turns.filter((turn) => turn.kind === "assistant")).toHaveLength(1);

	store.handlePiEvent(agentStart, testSessionId("a"));
	store.handlePiEvent(agentEnd, testSessionId("a"));
	store.handlePiEvent(recoveredOverflow, testSessionId("a"));

	expect(rt(testSessionId("a")).turns.filter((turn) => turn.kind === "assistant")).toHaveLength(1);
});

const compactionStart = (reason: "manual" | "threshold" | "overflow" = "threshold"): PiEvent => ({
	type: "compaction_start",
	reason,
});
const compactionEnd = (over: Partial<Extract<PiEvent, { type: "compaction_end" }>> = {}): PiEvent =>
	({
		type: "compaction_end",
		reason: "threshold",
		result: { tokensBefore: 268_909, estimatedTokensAfter: 12_000 },
		aborted: false,
		willRetry: false,
		...over,
	}) as PiEvent;
const compactionTurns = (sessionId: SessionId) =>
	rt(sessionId).turns.filter(
		(turn): turn is Extract<ChatTurn, { kind: "compaction" }> => turn.kind === "compaction",
	);

test("compaction lifecycle: a running notice settles in place (same id) with the token figures", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, testSessionId("a"));
	store.handlePiEvent(agentEnd, testSessionId("a"));
	store.handlePiEvent(compactionStart(), testSessionId("a"));
	const running = compactionTurns(testSessionId("a"));
	expect(running).toMatchObject([{ status: "running" }]);
	expect(rt(testSessionId("a")).isStreaming).toBe(true);
	expect(
		rt(testSessionId("a")).turns.filter(
			(turn) => turn.kind === "system" && turn.text === undefined,
		),
	).toHaveLength(0);

	store.handlePiEvent(compactionEnd(), testSessionId("a"));
	expect(compactionTurns(testSessionId("a"))).toMatchObject([
		{ id: running[0]?.id, status: "done", tokensBefore: 268_909, tokensAfter: 12_000 },
	]);

	store.handlePiEvent(agentSettled(), testSessionId("a"));
	const turns = rt(testSessionId("a")).turns;
	expect(turns.at(-1)).toMatchObject({ kind: "system" });
	expect(turns.at(-2)).toMatchObject({ kind: "compaction", status: "done" });
});

test("the incident sequence: truncated response → compacting → compacted-resuming, never a misleading Done", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, testSessionId("a"));
	store.handlePiEvent(assistantStart, testSessionId("a"));
	store.handlePiEvent(assistantText(""), testSessionId("a"));
	store.handlePiEvent(
		{
			type: "message_end",
			message: { role: "assistant", content: [], stopReason: "length" },
		} as unknown as PiEvent,
		testSessionId("a"),
	);
	store.handlePiEvent(agentEnd, testSessionId("a"));
	store.handlePiEvent(compactionStart("overflow"), testSessionId("a"));
	expect(compactionTurns(testSessionId("a"))).toMatchObject([{ status: "running" }]);

	store.handlePiEvent(
		compactionEnd({ reason: "overflow", willRetry: true, result: { tokensBefore: 268_909 } }),
		testSessionId("a"),
	);
	expect(compactionTurns(testSessionId("a"))).toMatchObject([
		{ status: "done", resuming: true, tokensBefore: 268_909 },
	]);
	expect(rt(testSessionId("a")).turns.filter((turn) => turn.kind === "assistant")).toHaveLength(0);
	expect(rt(testSessionId("a")).isStreaming).toBe(true);
	expect(
		rt(testSessionId("a")).turns.filter(
			(turn) => turn.kind === "system" && turn.text === undefined,
		),
	).toHaveLength(0);

	store.handlePiEvent(agentStart, testSessionId("a"));
	store.handlePiEvent(assistantStart, testSessionId("a"));
	store.handlePiEvent(assistantText("finished the rebase"), testSessionId("a"));
	store.handlePiEvent(agentEnd, testSessionId("a"));
	store.handlePiEvent(agentSettled(), testSessionId("a"));
	expect(rt(testSessionId("a")).turns.at(-1)).toMatchObject({ kind: "system" });
	expect(rt(testSessionId("a")).isStreaming).toBe(false);
	expect(compactionTurns(testSessionId("a"))[0]?.resuming).toBeUndefined();
});

test("a failed compaction settles into a visible, actionable notice — and a cancelled one into a muted record", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(compactionStart("manual"), testSessionId("a"));
	store.handlePiEvent(
		compactionEnd({ reason: "manual", result: undefined, errorMessage: "Compaction failed: boom" }),
		testSessionId("a"),
	);
	expect(compactionTurns(testSessionId("a"))).toMatchObject([
		{ status: "failed", detail: "Compaction failed: boom" },
	]);

	store.handlePiEvent(compactionStart("manual"), testSessionId("a"));
	store.handlePiEvent(
		compactionEnd({ reason: "manual", result: undefined, aborted: true }),
		testSessionId("a"),
	);
	expect(compactionTurns(testSessionId("a"))).toMatchObject([
		{ status: "failed" },
		{ status: "cancelled" },
	]);
});

test("manual compaction rejection appends one failed row only when no lifecycle was observed", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	const beforeEarlyFailure = selectCompactionTurnIds(useAppStore.getState(), testSessionId("a"));
	store.appendCompactionFailureUnlessObserved(
		testSessionId("a"),
		beforeEarlyFailure,
		"host unavailable",
	);
	expect(compactionTurns(testSessionId("a"))).toMatchObject([
		{ status: "failed", detail: "host unavailable" },
	]);

	const beforePiFailure = selectCompactionTurnIds(useAppStore.getState(), testSessionId("a"));
	store.handlePiEvent(compactionStart("manual"), testSessionId("a"));
	store.handlePiEvent(
		compactionEnd({ reason: "manual", result: undefined, errorMessage: "Nothing to compact" }),
		testSessionId("a"),
	);
	store.appendCompactionFailureUnlessObserved(
		testSessionId("a"),
		beforePiFailure,
		"request rejected",
	);

	expect(compactionTurns(testSessionId("a"))).toMatchObject([
		{ status: "failed", detail: "host unavailable" },
		{ status: "failed", detail: "Nothing to compact" },
	]);
});

test("a compaction_end with no observed start still lands a settled notice (connected mid-compaction)", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(compactionEnd(), testSessionId("a"));
	expect(compactionTurns(testSessionId("a"))).toMatchObject([
		{ status: "done", tokensBefore: 268_909, tokensAfter: 12_000 },
	]);
});

test("compact-and-retry produces one completion marker at final settlement", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, testSessionId("a"));
	store.handlePiEvent(agentEnd, testSessionId("a"));
	store.handlePiEvent(recoveredOverflow, testSessionId("a"));
	store.handlePiEvent(agentStart, testSessionId("a"));
	store.handlePiEvent(agentEnd, testSessionId("a"));
	expect(
		rt(testSessionId("a")).turns.filter(
			(turn) => turn.kind === "system" && turn.text === undefined,
		),
	).toHaveLength(0);

	store.handlePiEvent(agentSettled(), testSessionId("a"));
	expect(
		rt(testSessionId("a")).turns.filter(
			(turn) => turn.kind === "system" && turn.text === undefined,
		),
	).toHaveLength(1);
});

test("appendErrorTurn surfaces a failed send (a rejected prompt) as a visible error turn", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.appendUserMessage(testSessionId("a"), "do the thing");
	store.appendErrorTurn(testSessionId("a"), "No API key configured for provider openai");

	const err = rt(testSessionId("a")).turns.find((t) => t.kind === "error");
	expect(err?.kind === "error" && err.text).toContain("No API key");
	expect(failureRecovery(testSessionId("a"))).toBeUndefined();
	expect(rt(testSessionId("a")).isStreaming).toBe(false);
});

test("a rejected queued send cannot settle work the host is still running", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	store.handlePiEvent(agentStart, testSessionId("a"));
	store.handlePiEvent(assistantStart, testSessionId("a"));
	store.handlePiEvent(assistantText("still working"), testSessionId("a"));
	const currentAssistantId = rt(testSessionId("a")).currentAssistantId;

	store.appendErrorTurn(testSessionId("a"), "follow-up rejected");

	expect(rt(testSessionId("a")).isStreaming).toBe(true);
	expect(rt(testSessionId("a")).currentAssistantId).toBe(currentAssistantId);
	expect(rt(testSessionId("a")).turns.at(-1)).toMatchObject({
		kind: "error",
		text: "follow-up rejected",
	});
});

test("a message_update with no prior message_start still builds the turn (mid-stream hydration)", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.handlePiEvent(assistantText("partial reply"), testSessionId("a"));
	expect(rt(testSessionId("a")).turns.filter((t) => t.kind === "assistant")).toHaveLength(1);
	expect(rt(testSessionId("a")).currentAssistantId).not.toBeNull();

	store.handlePiEvent(assistantText("partial reply"), testSessionId("a"));
	expect(rt(testSessionId("a")).turns.filter((t) => t.kind === "assistant")).toHaveLength(1);
});

test("a durable session title event renames an open chat without moving attention", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("named"), null, "medium");
	const before = useAppStore.getState();
	const activeTab = before.activeTabByWorkspace.ws1;
	const navTick = before.navTickByWorkspace.ws1;

	store.handlePiEvent(sessionTitleChanged("Fix auth redirect"), testSessionId("named"));

	const after = useAppStore.getState();
	expect(
		after.tabsByWorkspace.ws1?.find((tab) => tab.kind === "chat" && tab.sessionId === "named")
			?.name,
	).toBe("Fix auth redirect");
	expect(after.activeTabByWorkspace.ws1).toBe(activeTab);
	expect(after.navTickByWorkspace.ws1).toBe(navTick);
	expect(rt(testSessionId("named")).eventRevision).toBe(1);
});

test("a durable session title event renames the chat's plan tab with it, open or closed", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("planned"), null, "medium");
	store.openDoc({
		kind: "plan",
		id: "ws1:plan:planned",
		workspaceId: testWorkspaceId("ws1"),
		name: "",
		sessionId: testSessionId("planned"),
	});
	const planName = () =>
		useAppStore
			.getState()
			.tabsByWorkspace.ws1?.find((tab) => tab.kind === "plan" && tab.sessionId === "planned")?.name;
	const queuedPlanName = () => {
		const queued = useAppStore
			.getState()
			.layoutIntents.find(
				(intent) =>
					intent.kind === "open" &&
					intent.tab.kind === "plan" &&
					intent.tab.sessionId === "planned",
			);
		return queued?.kind === "open" ? queued.tab.name : undefined;
	};

	store.handlePiEvent(sessionTitleChanged("Auth refactor"), testSessionId("planned"));
	expect(planName()).toBe("Auth refactor");
	expect(queuedPlanName()).toBe("Auth refactor");

	store.closeChatToHistory(testSessionId("planned"), true, testWorkspaceId("ws1"));
	store.handlePiEvent(sessionTitleChanged("Auth refactor, take two"), testSessionId("planned"));
	expect(planName()).toBe("Auth refactor, take two");
	expect(useAppStore.getState().closedChatsByWorkspace.ws1?.[0]?.title).toBe(
		"Auth refactor, take two",
	);
});

test("a durable title refreshes a placed plan document's name without requesting activation", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("placed-plan"), null, "medium");
	useAppStore.setState((state) => ({
		tabsByWorkspace: {
			...state.tabsByWorkspace,
			ws1: [
				...(state.tabsByWorkspace.ws1 ?? []),
				{
					kind: "plan",
					id: "plan-cache",
					workspaceId: testWorkspaceId("ws1"),
					name: "",
					sessionId: testSessionId("placed-plan"),
				},
			],
		},
		layoutIntents: [],
		layoutDocumentsByWorkspace: {
			ws1: {
				version: 2,
				center: {
					kind: "group",
					id: "center",
					tabs: [
						{
							kind: "chat",
							id: "chat-placement",
							name: "",
							sessionId: testSessionId("placed-plan"),
						},
						{
							kind: "document",
							id: "plan-placement",
							name: "",
							documentKind: "todo-plan",
							sourceId: "placed-plan",
							docPath: "TODO.md",
						},
					],
				},
				left: { visible: false, width: 0.2, groups: [] },
				right: { visible: false, width: 0.2, groups: [] },
				bottom: emptyBottomRegion(),
				toolRestoreTargets: {},
			},
		},
	}));

	store.handlePiEvent(sessionTitleChanged("Auth refactor"), testSessionId("placed-plan"));

	const state = useAppStore.getState();
	expect(state.tabsByWorkspace.ws1?.find((tab) => tab.id === "plan-cache")?.name).toBe(
		"Auth refactor",
	);
	expect(state.layoutIntents).toHaveLength(2);
	expect(state.layoutIntents).toContainEqual(
		expect.objectContaining({
			kind: "open",
			intent: "keep",
			activate: false,
			tab: expect.objectContaining({ kind: "plan", id: "plan-placement", name: "Auth refactor" }),
		}),
	);
	expect(state.layoutIntents).toContainEqual(
		expect.objectContaining({
			tab: expect.objectContaining({ kind: "chat", id: "chat-placement", name: "Auth refactor" }),
		}),
	);
});

test("a durable session title event renames closed history and clears it back to untitled", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("closed-title"), null, "medium");
	store.closeChatToHistory(testSessionId("closed-title"), true, testWorkspaceId("ws1"));

	store.handlePiEvent(sessionTitleChanged("Closed work"), testSessionId("closed-title"));
	expect(useAppStore.getState().closedChatsByWorkspace.ws1?.[0]?.title).toBe("Closed work");
	store.handlePiEvent(sessionTitleChanged(), testSessionId("closed-title"));
	expect(useAppStore.getState().closedChatsByWorkspace.ws1?.[0]?.title).toBe("");
});

test("a durable title updates a known tab without conjuring a runtime or title-event buffer", () => {
	useAppStore.setState({
		tabsByWorkspace: {
			ws1: [
				{
					kind: "chat",
					id: chatTabId(testWorkspaceId("ws1"), testSessionId("tab-only-title")),
					workspaceId: testWorkspaceId("ws1"),
					name: "Chat",
					sessionId: testSessionId("tab-only-title"),
				},
			],
		},
	});
	const sessions = useAppStore.getState().sessions;

	useAppStore
		.getState()
		.handlePiEvent(sessionTitleChanged("Named before hydrate"), testSessionId("tab-only-title"));

	const after = useAppStore.getState();
	expect(after.tabsByWorkspace.ws1?.[0]?.name).toBe("Named before hydrate");
	expect(after.sessions).toBe(sessions);
	expect(after.extUiOrphans).toEqual([]);
});

test("an event for an unknown session is a no-op (no runtime is conjured)", () => {
	const before = useAppStore.getState();
	before.handlePiEvent(agentStart, testSessionId("ghost"));
	useAppStore.getState().handlePiEvent(sessionTitleChanged("Ghost title"), testSessionId("ghost"));
	const after = useAppStore.getState();
	expect(after.sessions).toBe(before.sessions);
	expect(after.sessions.ghost).toBeUndefined();
	expect(after.tabsByWorkspace).toBe(before.tabsByWorkspace);
	expect(after.extUiOrphans).toEqual([]);
});

test("closeChatRuntime drops only its own runtime", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("b"), null, "medium");
	store.handlePiEvent(agentStart, testSessionId("b"));

	store.closeChatRuntime(testSessionId("a"));
	expect(useAppStore.getState().sessions.a).toBeUndefined();
	expect(rt(testSessionId("b")).isStreaming).toBe(true);
});

test("applyExtUi routes a dialog to its session; the reply clears only that one", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("b"), null, "medium");

	const dialog: ExtUiRequest = {
		id: "d1",
		sessionId: testSessionId("a"),
		kind: "confirm",
		title: "Proceed?",
		message: "Apply?",
	};
	store.applyExtUi(dialog);
	expect(rt(testSessionId("a")).pendingExtUi?.id).toBe("d1");
	expect(rt(testSessionId("b")).pendingExtUi).toBeNull();

	store.clearPendingExtUi(testSessionId("a"), "d1");
	expect(rt(testSessionId("a")).pendingExtUi).toBeNull();
});

test("applyExtUi reads a notify's level: only an error becomes an error turn", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	store.applyExtUi({
		id: "n1",
		sessionId: testSessionId("a"),
		kind: "notify",
		message: "Just so you know",
		level: "info",
	});
	store.applyExtUi({
		id: "n2",
		sessionId: testSessionId("a"),
		kind: "notify",
		message: "Careful",
		level: "warning",
	});
	store.applyExtUi({
		id: "n3",
		sessionId: testSessionId("a"),
		kind: "notify",
		message: "Extension theme-probe.ts failed on session_start: theme.fg is not a function",
		level: "error",
	});

	expect(rt(testSessionId("a")).turns.slice(-3)).toMatchObject([
		{ kind: "system", text: "Just so you know" },
		{ kind: "system", text: "Careful" },
		{
			kind: "error",
			text: "Extension theme-probe.ts failed on session_start: theme.fg is not a function",
		},
	]);
});

test("an ext-UI frame that beats its session.create response is replayed, not dropped", () => {
	const store = useAppStore.getState();

	store.applyExtUi({
		id: "s1",
		sessionId: testSessionId("late"),
		kind: "setStatus",
		key: "test",
		text: "Theme works",
	});
	store.applyExtUi({
		id: "n1",
		sessionId: testSessionId("late"),
		kind: "notify",
		message: "Extension theme-probe.ts failed on session_start: theme.fg is not a function",
		level: "error",
	});
	expect(useAppStore.getState().sessions.late).toBeUndefined();

	store.openChatSession(testWorkspaceId("ws1"), testSessionId("late"), null, "medium");

	expect(rt(testSessionId("late")).extUiStatus).toEqual({ test: "Theme works" });
	expect(rt(testSessionId("late")).turns.at(-1)).toMatchObject({
		kind: "error",
		text: "Extension theme-probe.ts failed on session_start: theme.fg is not a function",
	});
	expect(useAppStore.getState().extUiOrphans).toEqual([]);
});

test("an extra-usage notice survives the create race, dismisses per chat, and silences every chat", () => {
	const store = useAppStore.getState();
	store.applyExtUi({
		id: "x1",
		sessionId: testSessionId("a"),
		kind: "notice",
		notice: "anthropicExtraUsage",
	});
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("b"), null, "medium");
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("c"), null, "medium");
	store.applyExtUi({
		id: "x2",
		sessionId: testSessionId("b"),
		kind: "notice",
		notice: "anthropicExtraUsage",
	});
	store.applyExtUi({
		id: "x3",
		sessionId: testSessionId("c"),
		kind: "notice",
		notice: "anthropicExtraUsage",
	});
	expect(rt(testSessionId("a")).notice).toBe("anthropicExtraUsage");

	store.dismissSessionNotice(testSessionId("a"));
	expect(rt(testSessionId("a")).notice).toBeNull();
	expect(rt(testSessionId("b")).notice).toBe("anthropicExtraUsage");

	store.silenceNotice("anthropicExtraUsage");
	expect(rt(testSessionId("b")).notice).toBeNull();
	expect(rt(testSessionId("c")).notice).toBeNull();
});

test("Don't warn again also drops a buffered notice for a chat not opened yet", () => {
	const store = useAppStore.getState();
	store.applyExtUi({
		id: "x4",
		sessionId: testSessionId("later"),
		kind: "notice",
		notice: "anthropicExtraUsage",
	});
	store.applyExtUi({
		id: "s4",
		sessionId: testSessionId("later"),
		kind: "setStatus",
		key: "k",
		text: "kept",
	});
	store.silenceNotice("anthropicExtraUsage");
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("later"), null, "medium");
	expect(rt(testSessionId("later")).notice).toBeNull();
	expect(rt(testSessionId("later")).extUiStatus).toEqual({ k: "kept" });
});

test("a dialog for an unknown session is dropped, never replayed as a phantom", () => {
	const store = useAppStore.getState();

	store.applyExtUi({
		id: "d-late",
		sessionId: testSessionId("dialog"),
		kind: "confirm",
		title: "Proceed?",
		message: "Apply?",
	});
	expect(useAppStore.getState().extUiOrphans).toEqual([]);

	store.openChatSession(testWorkspaceId("ws1"), testSessionId("dialog"), null, "medium");
	expect(rt(testSessionId("dialog")).pendingExtUi).toBeNull();
	expect(rt(testSessionId("dialog")).extUiQueue).toEqual([]);
});

test("an exact host-authored pending dialog replays when its session hydrates", () => {
	const store = useAppStore.getState();
	const request = {
		id: "d-authoritative",
		sessionId: testSessionId("dialog-authoritative"),
		kind: "confirm" as const,
		title: "Proceed?",
		message: "Apply?",
	};
	store.installSessionStateSnapshot([
		{
			sessionId: request.sessionId,
			workspaceId: testWorkspaceId("ws1"),
			projectId: testProjectId("p1"),
			state: {
				execution: "running",
				runId: "run-dialog",
				needsInput: {
					interactionId: `dialog:${request.id}`,
					kind: "dialog",
					request,
				},
				completion: null,
				completionUnread: false,
				queuedCount: 0,
				backgroundWork: false,
			},
		},
	]);
	store.applyExtUi(request);
	expect(useAppStore.getState().extUiOrphans).toEqual([request]);

	store.openChatSession(testWorkspaceId("ws1"), request.sessionId, null, "medium");
	expect(rt(request.sessionId).pendingExtUi).toEqual(request);
	expect(useAppStore.getState().extUiOrphans).toEqual([]);
	store.applySessionState({
		sessionId: request.sessionId,
		workspaceId: testWorkspaceId("ws1"),
		projectId: testProjectId("p1"),
		state: {
			execution: "running",
			runId: "run-dialog",
			needsInput: null,
			completion: null,
			completionUnread: false,
			queuedCount: 0,
			backgroundWork: false,
		},
	});
	expect(rt(request.sessionId).pendingExtUi).toBeNull();
});

test("a peer-cleared host dialog cannot replay from the orphan buffer", () => {
	const store = useAppStore.getState();
	const request = {
		id: "d-peer-cleared",
		sessionId: testSessionId("dialog-peer-cleared"),
		kind: "confirm" as const,
		title: "Proceed?",
		message: "Apply?",
	};
	const base = {
		sessionId: request.sessionId,
		workspaceId: testWorkspaceId("ws1"),
		projectId: testProjectId("p1"),
	};
	store.applySessionState({
		...base,
		state: {
			execution: "running",
			runId: "run-dialog",
			needsInput: {
				interactionId: `dialog:${request.id}`,
				kind: "dialog",
				request,
			},
			completion: null,
			completionUnread: false,
			queuedCount: 0,
			backgroundWork: false,
		},
	});
	store.applyExtUi(request);
	expect(useAppStore.getState().extUiOrphans).toEqual([request]);
	store.applySessionState({
		...base,
		state: {
			execution: "running",
			runId: "run-dialog",
			needsInput: null,
			completion: null,
			completionUnread: false,
			queuedCount: 0,
			backgroundWork: false,
		},
	});
	expect(useAppStore.getState().extUiOrphans).toEqual([]);
	store.openChatSession(testWorkspaceId("ws1"), request.sessionId, null, "medium");
	expect(rt(request.sessionId).pendingExtUi).toBeNull();
});

test("a frame for a chat closed to history still applies, and orphans stay bounded", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("closed"), null, "medium");
	store.closeChatToHistory(testSessionId("closed"), true, testWorkspaceId("ws1"));

	store.applyExtUi({
		id: "t1",
		sessionId: testSessionId("closed"),
		kind: "setTitle",
		title: "Renamed later",
	});
	const closed = useAppStore
		.getState()
		.closedChatsByWorkspace.ws1?.find((chat) => chat.sessionId === "closed");
	expect(closed?.title).toBe("Renamed later");
	expect(useAppStore.getState().extUiOrphans).toEqual([]);

	for (let i = 0; i < 70; i++) {
		store.applyExtUi({
			id: `f${i}`,
			sessionId: testSessionId("never-opened"),
			kind: "setStatus",
			key: "k",
			text: String(i),
		});
	}
	const orphans = useAppStore.getState().extUiOrphans;
	expect(orphans).toHaveLength(64);
	expect(orphans.at(-1)).toMatchObject({ id: "f69" });
});

test("a frame for a chat known only as a tab is buffered, never silently dropped", () => {
	const store = useAppStore.getState();
	useAppStore.setState({
		tabsByWorkspace: {
			ws1: [
				{
					kind: "chat",
					id: chatTabId(testWorkspaceId("ws1"), testSessionId("tab-only")),
					workspaceId: testWorkspaceId("ws1"),
					name: "Chat",
					sessionId: testSessionId("tab-only"),
				},
			],
		},
	});

	store.applyExtUi({
		id: "s1",
		sessionId: testSessionId("tab-only"),
		kind: "setStatus",
		key: "test",
		text: "Theme works",
	});

	expect(useAppStore.getState().sessions["tab-only"]).toBeUndefined();
	expect(useAppStore.getState().extUiOrphans).toMatchObject([{ id: "s1" }]);
});

test("a frame that beats a reopened chat's transcript is replayed by hydrateSession", () => {
	const store = useAppStore.getState();

	store.applyExtUi({
		id: "s1",
		sessionId: testSessionId("reopened"),
		kind: "setStatus",
		key: "test",
		text: "Theme works",
	});
	expect(useAppStore.getState().extUiOrphans).toMatchObject([{ id: "s1" }]);

	const summary: SessionSummary = {
		sessionId: testSessionId("reopened"),
		workspaceId: testWorkspaceId("ws1"),
		title: "Chat",
		model: null,
		thinkingLevel: "medium",
		isStreaming: false,
		messageCount: 0,
		updatedAt: 0,
		live: true,
	};
	store.hydrateSession(summary, emptyHydration());

	expect(rt(testSessionId("reopened")).extUiStatus).toEqual({ test: "Theme works" });
	expect(useAppStore.getState().extUiOrphans).toEqual([]);
});

test("setTitle refreshes shared chat metadata without requesting activation", () => {
	const store = useAppStore.getState();
	const cacheId = chatTabId(testWorkspaceId("ws1"), testSessionId("a"));
	const placementId = "legacy-chat-placement";
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	useAppStore.setState({
		layoutIntents: [],
		layoutDocumentsByWorkspace: {
			ws1: {
				version: 2,
				center: {
					kind: "group",
					id: "center",
					tabs: [{ kind: "chat", id: placementId, name: "Chat", sessionId: testSessionId("a") }],
				},
				left: { visible: false, width: 0.2, groups: [] },
				right: { visible: false, width: 0.2, groups: [] },
				bottom: emptyBottomRegion(),
				toolRestoreTargets: {},
			},
		},
	});

	store.applyExtUi({
		id: "title-1",
		sessionId: testSessionId("a"),
		kind: "setTitle",
		title: "Migration plan",
	});
	const state = useAppStore.getState();
	expect(state.tabsByWorkspace.ws1?.find((tab) => tab.id === cacheId)?.name).toBe("Migration plan");
	expect(state.layoutIntents).toHaveLength(1);
	expect(state.layoutIntents[0]).toMatchObject({
		kind: "open",
		workspaceId: testWorkspaceId("ws1"),
		intent: "keep",
		activate: false,
		tab: { id: placementId, name: "Migration plan", sessionId: testSessionId("a") },
	});

	const staleDocument = state.layoutDocumentsByWorkspace.ws1;
	if (!staleDocument) throw new Error("missing title layout fixture");
	useAppStore.setState({
		layoutIntents: [],
		layoutDocumentsByWorkspace: {
			ws1: {
				...staleDocument,
				center: {
					kind: "group",
					id: "center",
					tabs: [{ kind: "chat", id: placementId, name: "Stale", sessionId: testSessionId("a") }],
				},
			},
		},
	});
	store.applyExtUi({
		id: "title-1b",
		sessionId: testSessionId("a"),
		kind: "setTitle",
		title: "Migration plan",
	});
	expect(useAppStore.getState().layoutIntents[0]).toMatchObject({
		kind: "open",
		tab: { id: placementId, name: "Migration plan", sessionId: testSessionId("a") },
	});

	const cache = useAppStore.getState().tabsByWorkspace.ws1?.find((tab) => tab.id === cacheId);
	if (!cache) throw new Error("missing title cache fixture");
	useAppStore.setState({ layoutIntents: [] });
	store.openTab(cache, "keep", true, { activate: false });
	expect(useAppStore.getState().layoutIntents[0]).toMatchObject({ tab: { id: cacheId } });
	store.applyExtUi({
		id: "title-1c",
		sessionId: testSessionId("a"),
		kind: "setTitle",
		title: "Migration plan",
	});
	expect(useAppStore.getState().layoutIntents[0]).toMatchObject({
		kind: "open",
		tab: { id: placementId, name: "Migration plan", sessionId: testSessionId("a") },
	});
});

test("setTitle cannot restore a cache whose structural close is already accepted", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	useAppStore.setState({
		layoutIntents: [],
		layoutDocumentsByWorkspace: {
			ws1: {
				version: 2,
				center: { kind: "group", id: "center", tabs: [] },
				left: { visible: false, width: 0.2, groups: [] },
				right: { visible: false, width: 0.2, groups: [] },
				bottom: emptyBottomRegion(),
				toolRestoreTargets: {},
			},
		},
	});
	store.applyExtUi({
		id: "title-2",
		sessionId: testSessionId("a"),
		kind: "setTitle",
		title: "Closed title",
	});
	expect(useAppStore.getState().layoutIntents).toEqual([]);
	expect(useAppStore.getState().tabsByWorkspace.ws1?.[0]?.name).toBe("Closed title");
});

test("setTitle repairs the title of a still-live chat in local history", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	store.closeChatToHistory(testSessionId("a"), true, testWorkspaceId("ws1"));
	store.applyExtUi({
		id: "title-3",
		sessionId: testSessionId("a"),
		kind: "setTitle",
		title: "Finished title",
	});
	expect(useAppStore.getState().closedChatsByWorkspace.ws1?.[0]?.title).toBe("Finished title");
});

test("a second dialog for a busy session queues instead of orphaning the first", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	const mk = (id: string): ExtUiRequest => ({
		id,
		sessionId: testSessionId("a"),
		kind: "input",
		title: "name?",
	});
	store.applyExtUi(mk("d1"));
	store.applyExtUi(mk("d2"));
	expect(rt(testSessionId("a")).pendingExtUi?.id).toBe("d1");
	expect(rt(testSessionId("a")).extUiQueue.map((q) => q.id)).toEqual(["d2"]);

	store.clearPendingExtUi(testSessionId("a"), "d1");
	expect(rt(testSessionId("a")).pendingExtUi?.id).toBe("d2");
	expect(rt(testSessionId("a")).extUiQueue).toHaveLength(0);
});

test("closing a chat moves it to history with its runtime kept; reopening restores full state", () => {
	const store = useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws1") });
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	store.handlePiEvent(agentStart, testSessionId("a"));
	useAppStore.setState({
		chatLocationRequest: {
			workspaceId: testWorkspaceId("ws1"),
			projectId: testProjectId("p1"),
			sessionId: testSessionId("a"),
			messageIndex: 0,
			anchorText: "target",
		},
		historyOpenRequest: { id: "history-a", sessionId: testSessionId("a") },
	});

	store.closeChatToHistory(testSessionId("a"));
	let st = useAppStore.getState();
	expect(st.tabsByWorkspace.ws1?.some((t) => t.kind === "chat" && t.sessionId === "a")).toBe(false);
	expect(st.closedChatsByWorkspace.ws1?.map((c) => c.sessionId)).toEqual([testSessionId("a")]);
	expect(st.sessions.a).toBeDefined();
	expect(st.sessions.a?.isStreaming).toBe(true);
	expect(st.chatLocationRequest).toBeNull();
	expect(st.historyOpenRequest).toBeNull();

	const activeAfterClose = st.activeTabByWorkspace.ws1;
	const placedId = "legacy:chat:a";
	store.restorePlacedChatCache(
		testWorkspaceId("ws1"),
		placedId,
		testSessionId("a"),
		"Restored chat",
	);
	st = useAppStore.getState();
	expect(st.tabsByWorkspace.ws1?.some((tab) => tab.id === placedId)).toBe(true);
	expect(st.closedChatsByWorkspace.ws1 ?? []).toHaveLength(0);
	expect(st.activeTabByWorkspace.ws1).toBe(activeAfterClose);
	store.restorePlacedChatCache(
		testWorkspaceId("ws1"),
		placedId,
		testSessionId("a"),
		"Peer-renamed chat",
	);
	st = useAppStore.getState();
	expect(st.tabsByWorkspace.ws1?.find((tab) => tab.id === placedId)?.name).toBe(
		"Peer-renamed chat",
	);
	store.closeChatToHistory(testSessionId("a"));
	expect(useAppStore.getState().closedChatsByWorkspace.ws1?.[0]?.title).toBe("Peer-renamed chat");

	store.reopenChat(testWorkspaceId("ws1"), testSessionId("a"));
	st = useAppStore.getState();
	expect(st.tabsByWorkspace.ws1?.some((t) => t.kind === "chat" && t.sessionId === "a")).toBe(true);
	expect(st.activeTabByWorkspace.ws1).toBe(chatTabId(testWorkspaceId("ws1"), testSessionId("a")));
	expect(st.closedChatsByWorkspace.ws1 ?? []).toHaveLength(0);
	expect(st.sessions.a?.isStreaming).toBe(true);
});

test("reopening a chat targets its captured workspace after the user switches away", () => {
	const store = useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws1") });
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("captured"), null, "medium");
	store.closeChatToHistory(testSessionId("captured"));
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws2") });
	store.reopenChat(testWorkspaceId("ws1"), testSessionId("captured"), { activate: false });
	const state = useAppStore.getState();
	expect(
		state.tabsByWorkspace.ws1?.some((tab) => tab.kind === "chat" && tab.sessionId === "captured"),
	).toBe(true);
	expect(state.tabsByWorkspace.ws2).toBeUndefined();
	expect(state.activeWorkspaceId).toBe(testWorkspaceId("ws2"));
});

test("deleteChat removes history/runtime state and falls back when deleting the active tab", () => {
	const store = useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws1") });
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("b"), null, "medium");

	store.closeChatToHistory(testSessionId("a"));
	store.deleteChat(testWorkspaceId("ws1"), testSessionId("a"));
	let st = useAppStore.getState();
	expect(st.closedChatsByWorkspace.ws1 ?? []).toHaveLength(0);
	expect(st.sessions.a).toBeUndefined();
	expect(st.skillsSyncedTickBySession.a).toBeUndefined();
	expect(st.sessions.b).toBeDefined();

	store.openChatSession(testWorkspaceId("ws1"), testSessionId("c"), null, "medium");
	const beforeNav = useAppStore.getState().navTickByWorkspace.ws1 ?? 0;
	store.deleteChat(testWorkspaceId("ws1"), testSessionId("c"));
	st = useAppStore.getState();
	expect(st.tabsByWorkspace.ws1?.some((t) => t.kind === "chat" && t.sessionId === "c")).toBe(false);
	expect(st.activeTabByWorkspace.ws1).toBe(chatTabId(testWorkspaceId("ws1"), testSessionId("b")));
	expect(st.navTickByWorkspace.ws1).toBe(beforeNav + 1);
	expect(st.sessions.c).toBeUndefined();
});

test("session-list reconciliation removes missed deletions without deleting a chat created mid-read", () => {
	const store = useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws1") });
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("stale"), null, "medium");
	const baseline = selectWorkspaceSessionIds(useAppStore.getState(), testWorkspaceId("ws1"));

	store.openChatSession(testWorkspaceId("ws1"), testSessionId("newcomer"), null, "medium");
	store.reconcileWorkspaceSessions(testWorkspaceId("ws1"), baseline, []);

	const state = useAppStore.getState();
	expect(state.sessions.stale).toBeUndefined();
	expect(state.deletedSessionsByWorkspace.ws1?.stale).toBe(true);
	expect(
		state.tabsByWorkspace.ws1?.some((tab) => tab.kind === "chat" && tab.sessionId === "stale"),
	).toBe(false);
	expect(state.sessions.newcomer).toBeDefined();
	expect(state.activeTabByWorkspace.ws1).toBe(
		chatTabId(testWorkspaceId("ws1"), testSessionId("newcomer")),
	);
});

test("authoritative session reconciliation never impersonates user navigation", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("missing"), null, "medium");
	const baseline = selectWorkspaceSessionIds(useAppStore.getState(), testWorkspaceId("ws1"));
	const before = useAppStore.getState().navTickByWorkspace.ws1 ?? 0;
	store.reconcileWorkspaceSessions(testWorkspaceId("ws1"), baseline, []);
	const state = useAppStore.getState();
	expect(state.activeTabByWorkspace.ws1).toBeNull();
	expect(state.navTickByWorkspace.ws1 ?? 0).toBe(before);
});

test("session deletion drops queued chat and live-plan opens before pruning placement", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("queued"), null, "medium");
	store.openDoc({
		kind: "plan",
		id: "queued-plan",
		workspaceId: testWorkspaceId("ws1"),
		name: "Queued plan",
		sessionId: testSessionId("queued"),
	});
	store.deleteChat(testWorkspaceId("ws1"), testSessionId("queued"), false);
	const afterDeletion = useAppStore.getState();
	const intents = afterDeletion.layoutIntents;
	expect(afterDeletion.tabsByWorkspace.ws1 ?? []).toHaveLength(0);
	expect(
		intents.some(
			(intent) =>
				intent.kind === "open" &&
				(intent.tab.kind === "chat" || intent.tab.kind === "plan") &&
				intent.tab.sessionId === "queued",
		),
	).toBe(false);
	expect(intents.at(-1)).toMatchObject({
		kind: "remove-session",
		workspaceId: testWorkspaceId("ws1"),
		sessionId: testSessionId("queued"),
	});
});

test("a deletion that beats session.create prevents its late response from restoring the chat", () => {
	const store = useAppStore.getState();

	store.deleteChat(testWorkspaceId("ws1"), testSessionId("late"));
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("late"), null, "medium");
	store.openTab(
		{
			kind: "chat",
			id: "late-cache",
			workspaceId: testWorkspaceId("ws1"),
			name: "Late cache",
			sessionId: testSessionId("late"),
		},
		"keep",
		false,
	);
	store.openDoc({
		kind: "doc",
		id: "late-todo",
		workspaceId: testWorkspaceId("ws1"),
		name: "Late TODO",
		content: "# Late",
		docPath: "TODO.md",
		sourceId: "late",
	});
	store.requestChatLocation({
		workspaceId: testWorkspaceId("ws1"),
		projectId: testProjectId("p1"),
		sessionId: testSessionId("late"),
		messageIndex: 0,
		anchorText: "late",
	});
	store.requestHistoryOpen({
		workspaceId: testWorkspaceId("ws1"),
		sessionId: testSessionId("late"),
		tabId: "late",
	});

	const state = useAppStore.getState();
	expect(state.sessions.late).toBeUndefined();
	expect(state.tabsByWorkspace.ws1 ?? []).toHaveLength(0);
	expect(
		state.layoutIntents.some((intent) => intent.kind === "open" && intent.workspaceId === "ws1"),
	).toBe(false);
	expect(state.chatLocationRequest).toBeNull();
	expect(state.historyOpenRequest).toBeNull();
});

test("a deletion that beats getMessages prevents its late hydrate from restoring the chat", () => {
	const store = useAppStore.getState();
	const summary: SessionSummary = {
		sessionId: testSessionId("late"),
		workspaceId: testWorkspaceId("ws1"),
		title: "Deleted chat",
		model: null,
		thinkingLevel: "medium",
		isStreaming: false,
		messageCount: 1,
		updatedAt: 1,
		live: true,
	};

	store.deleteChat(testWorkspaceId("ws1"), testSessionId("late"));
	store.hydrateSession(summary, {
		turns: [],
		toolResults: {},
		toolResponses: {},
		turnIdByMessageIndex: [],
	});

	const state = useAppStore.getState();
	expect(state.sessions.late).toBeUndefined();
	expect(state.tabsByWorkspace.ws1 ?? []).toHaveLength(0);
});

test("a page-lifetime deletion tombstone survives workspace cleanup until late hydration settles", () => {
	const store = useAppStore.getState();
	const summary: SessionSummary = {
		sessionId: testSessionId("late"),
		workspaceId: testWorkspaceId("ws1"),
		title: "Deleted chat",
		model: null,
		thinkingLevel: "medium",
		isStreaming: false,
		messageCount: 1,
		updatedAt: 1,
		live: true,
	};

	store.deleteChat(testWorkspaceId("ws1"), testSessionId("late"));
	store.clearWorkspaceTabs(testWorkspaceId("ws1"));
	store.hydrateSession(summary, emptyHydration());

	expect(useAppStore.getState().sessions.late).toBeUndefined();
});

test("a deletion that beats session.list prevents its late history row from returning", () => {
	const store = useAppStore.getState();

	store.deleteChat(testWorkspaceId("ws1"), testSessionId("late"));
	store.noteClosedChats(testWorkspaceId("ws1"), [
		{ sessionId: testSessionId("late"), title: "Deleted chat", closedAt: 1 },
	]);

	expect(useAppStore.getState().closedChatsByWorkspace.ws1 ?? []).toHaveLength(0);
});

test("hydrateSession rebuilds a runtime + tab on connect, and never clobbers a live one", () => {
	const store = useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws1") });
	const summary: SessionSummary = {
		sessionId: testSessionId("h1"),
		workspaceId: testWorkspaceId("ws1"),
		title: "Chat",
		model: null,
		thinkingLevel: "medium",
		isStreaming: false,
		messageCount: 1,
		updatedAt: 0,
		live: true,
	};
	store.hydrateSession(summary, {
		turns: [{ kind: "user", id: "u1", message: { role: "user", content: "hi", timestamp: 0 } }],
		toolResults: {},
		toolResponses: {},
		turnIdByMessageIndex: ["u1"],
	});
	const st = useAppStore.getState();
	expect(st.sessions.h1?.turns).toHaveLength(1);
	expect(st.sessions.h1?.turnIdByMessageIndex).toEqual(["u1"]);
	expect(st.tabsByWorkspace.ws1?.some((t) => t.kind === "chat" && t.sessionId === "h1")).toBe(true);

	store.hydrateSession({ ...summary, messageCount: 99 }, emptyHydration());
	expect(useAppStore.getState().sessions.h1?.turns).toHaveLength(1);
});

test("reconcileSession replaces stale host state while preserving browser-local state", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("sync"), null, "medium");
	store.setChatDraft(testSessionId("sync"), "keep my draft");
	store.appendUserMessage(testSessionId("sync"), "old summarized prompt");
	store.handlePiEvent(agentStart, testSessionId("sync"));
	store.handlePiEvent({ type: "compaction_start", reason: "overflow" }, testSessionId("sync"));
	store.handlePiEvent(
		{
			type: "compaction_end",
			reason: "overflow",
			result: { tokensBefore: 268_000, estimatedTokensAfter: 24_000 },
			aborted: false,
			willRetry: true,
		},
		testSessionId("sync"),
	);

	const before = rt(testSessionId("sync"));
	const liveCompaction = before.turns.findLast((turn) => turn.kind === "compaction");
	if (liveCompaction?.kind !== "compaction") throw new Error("live compaction missing");
	const summary: SessionSummary = {
		sessionId: testSessionId("sync"),
		workspaceId: testWorkspaceId("ws1"),
		title: "Chat",
		model: null,
		thinkingLevel: "high",
		isStreaming: true,
		messageCount: 2,
		updatedAt: 2,
		live: true,
		queue: { steering: [], followUp: ["continue afterward"] },
	};
	const applied = store.reconcileSession(
		summary,
		{
			turns: [
				{
					kind: "compaction",
					id: "persisted-compaction",
					status: "done",
					summary: "## Earlier work\nFinished the investigation.",
					tokensBefore: 268_000,
				},
			],
			toolResults: {},
			toolResponses: {},
			turnIdByMessageIndex: [null],
		},
		before.eventRevision,
		7,
	);

	expect(applied).toBe(true);
	const after = rt(testSessionId("sync"));
	expect(after.turns).toHaveLength(1);
	expect(after.turns[0]).toEqual({
		kind: "compaction",
		id: liveCompaction.id,
		status: "done",
		summary: "## Earlier work\nFinished the investigation.",
		tokensBefore: 268_000,
		tokensAfter: 24_000,
		resuming: true,
	});
	expect(after.draft).toBe("keep my draft");
	expect(after.queue).toEqual({ steering: [], followUp: ["continue afterward"] });
	expect(after.thinkingLevel).toBe("high");
	expect(after.syncedConnectionGeneration).toBe(7);
	expect(after.eventRevision).toBe(before.eventRevision + 1);
	expect(after.statsRefreshTick).toBe(before.statsRefreshTick);
});

test("reconcileSession rejects a transcript read crossed by even a UI-ignored Pi event", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("sync-race"), null, "medium");
	store.appendUserMessage(testSessionId("sync-race"), "keep this turn");
	const expectedRevision = rt(testSessionId("sync-race")).eventRevision;

	store.handlePiEvent({ type: "turn_start" } as PiEvent, testSessionId("sync-race"));
	const crossed = rt(testSessionId("sync-race"));
	expect(crossed.eventRevision).toBe(expectedRevision + 1);

	const applied = store.reconcileSession(
		{
			sessionId: testSessionId("sync-race"),
			workspaceId: testWorkspaceId("ws1"),
			title: "Chat",
			model: null,
			thinkingLevel: "medium",
			isStreaming: false,
			messageCount: 0,
			updatedAt: 2,
			live: true,
		},
		emptyHydration(),
		expectedRevision,
		3,
	);

	expect(applied).toBe(false);
	expect(rt(testSessionId("sync-race")).turns).toHaveLength(1);
	expect(rt(testSessionId("sync-race")).syncedConnectionGeneration).not.toBe(3);
});

test("noteClosedChats surfaces disk-only sessions in history, skipping live/open/known ones", () => {
	const store = useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws1") });
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("live1"), null, "medium");

	store.noteClosedChats(testWorkspaceId("ws1"), [
		{ sessionId: testSessionId("disk1"), title: "Old chat", closedAt: 200 },
		{ sessionId: testSessionId("disk2"), title: "Older chat", closedAt: 100 },
		{ sessionId: testSessionId("live1"), title: "dup of open tab", closedAt: 300 },
	]);
	let history = useAppStore.getState().closedChatsByWorkspace.ws1 ?? [];
	expect(history.map((c) => c.sessionId)).toEqual([testSessionId("disk1"), testSessionId("disk2")]);

	store.noteClosedChats(testWorkspaceId("ws1"), [
		{ sessionId: testSessionId("disk1"), title: "Old chat", closedAt: 200 },
	]);
	history = useAppStore.getState().closedChatsByWorkspace.ws1 ?? [];
	expect(history).toHaveLength(2);
	store.noteClosedChats(testWorkspaceId("ws1"), [
		{ sessionId: testSessionId("disk1"), title: "Renamed chat", closedAt: 400 },
	]);
	history = useAppStore.getState().closedChatsByWorkspace.ws1 ?? [];
	expect(history.find((chat) => chat.sessionId === "disk1")).toEqual({
		sessionId: testSessionId("disk1"),
		title: "Renamed chat",
		closedAt: 200,
	});
	store.noteClosedChats(testWorkspaceId("ws1"), [
		{
			sessionId: testSessionId("disk2"),
			title: "",
			firstPrompt: "the older prompt",
			closedAt: 100,
		},
	]);
	history = useAppStore.getState().closedChatsByWorkspace.ws1 ?? [];
	expect(history.find((chat) => chat.sessionId === "disk2")).toEqual({
		sessionId: testSessionId("disk2"),
		title: "",
		firstPrompt: "the older prompt",
		closedAt: 100,
	});
	store.noteClosedChats(testWorkspaceId("ws1"), [
		{ sessionId: testSessionId("disk2"), title: "", closedAt: 100 },
	]);
	expect(
		useAppStore.getState().closedChatsByWorkspace.ws1?.find((chat) => chat.sessionId === "disk2")
			?.firstPrompt,
	).toBe("the older prompt");

	store.openChatSession(testWorkspaceId("ws1"), testSessionId("disk1"), null, "medium");
	history = useAppStore.getState().closedChatsByWorkspace.ws1 ?? [];
	expect(history.map((chat) => chat.sessionId)).toEqual([testSessionId("disk2")]);
});

test("opening a chat never steals another resource's canonical cache id", () => {
	const collidingId = chatTabId(testWorkspaceId("ws1"), testSessionId("collision-session"));
	const file: FileTab = {
		kind: "file",
		id: collidingId,
		workspaceId: testWorkspaceId("ws1"),
		name: "collision.ts",
		path: "collision.ts",
		content: "kept",
	};
	useAppStore.setState({ tabsByWorkspace: { ws1: [file] }, layoutIntents: [] });
	useAppStore
		.getState()
		.openChatSession(testWorkspaceId("ws1"), testSessionId("collision-session"), null, "medium");
	const tabs = useAppStore.getState().tabsByWorkspace.ws1 ?? [];
	const openedChat = tabs.find((tab) => tab.kind === "chat");

	expect(tabs.find((tab) => tab.kind === "file")).toEqual(file);
	expect(openedChat?.sessionId).toBe(testSessionId("collision-session"));
	expect(openedChat?.id).not.toBe(file.id);
	expect(useAppStore.getState().layoutIntents.at(-1)).toMatchObject({
		kind: "open",
		tab: { id: openedChat?.id, sessionId: testSessionId("collision-session") },
	});
});

test("restoring a stable chat placement never steals another resource's cache id", () => {
	const file = fileTab(testWorkspaceId("ws1"), "stable-placement-id");
	useAppStore.setState({ tabsByWorkspace: { ws1: [file] } });
	useAppStore
		.getState()
		.restorePlacedChatCache(
			testWorkspaceId("ws1"),
			file.id,
			testSessionId("collision-session"),
			"Chat",
		);
	const tabs = useAppStore.getState().tabsByWorkspace.ws1 ?? [];
	const restoredFile = tabs.find((tab) => tab.kind === "file");
	const restoredChat = tabs.find((tab) => tab.kind === "chat");

	expect(restoredFile).toEqual(file);
	expect(restoredChat?.sessionId).toBe(testSessionId("collision-session"));
	expect(restoredChat?.id).not.toBe(file.id);
});

test("hydrateSession preserves the stable id of an already-restored shared placement", () => {
	const store = useAppStore.getState();
	const summary: SessionSummary = {
		sessionId: testSessionId("legacy-session"),
		workspaceId: testWorkspaceId("ws1"),
		title: "Restored",
		model: null,
		thinkingLevel: "medium",
		isStreaming: false,
		messageCount: 0,
		updatedAt: 1,
		live: true,
	};
	store.restorePlacedChatCache(
		testWorkspaceId("ws1"),
		"legacy-placement-id",
		summary.sessionId,
		summary.title,
	);
	store.hydrateSession(summary, emptyHydration(), false);
	const chats = useAppStore.getState().tabsByWorkspace.ws1?.filter((tab) => tab.kind === "chat");
	expect(chats).toHaveLength(1);
	expect(chats?.[0]?.id).toBe("legacy-placement-id");
});

test("hydrateSession(activate) reopens a disk-only chat: builds it, focuses it, and drops it from history", () => {
	const store = useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws1") });
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("other"), null, "medium");
	store.noteClosedChats(testWorkspaceId("ws1"), [
		{ sessionId: testSessionId("disk1"), title: "Old", closedAt: 1 },
	]);

	const summary: SessionSummary = {
		sessionId: testSessionId("disk1"),
		workspaceId: testWorkspaceId("ws1"),
		title: "Old",
		model: null,
		thinkingLevel: "medium",
		isStreaming: false,
		messageCount: 2,
		updatedAt: 1,
		live: true,
	};
	store.hydrateSession(summary, emptyHydration(), true);

	const st = useAppStore.getState();
	expect(st.sessions.disk1).toBeDefined();
	expect(st.closedChatsByWorkspace.ws1 ?? []).toHaveLength(0);
	expect(st.activeTabByWorkspace.ws1).toBe(
		chatTabId(testWorkspaceId("ws1"), testSessionId("disk1")),
	);
});

test("clearWorkspaceTabs drops both open and closed chat runtimes + clears history", () => {
	const store = useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws1") });
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("b"), null, "medium");
	store.closeChatToHistory(testSessionId("a"));

	store.clearWorkspaceTabs(testWorkspaceId("ws1"));
	const st = useAppStore.getState();
	expect(st.sessions.a).toBeUndefined();
	expect(st.sessions.b).toBeUndefined();
	expect(st.closedChatsByWorkspace.ws1).toBeUndefined();
	expect(st.tabsByWorkspace.ws1).toBeUndefined();
});

test("requestChatLocation sets the jump deep link AND switches project+workspace atomically; clearChatLocation drops it", () => {
	const store = useAppStore.getState();
	useAppStore.setState({
		selectedProjectId: testProjectId("p1"),
		activeWorkspaceId: testWorkspaceId("ws1"),
	});

	store.requestChatLocation({
		workspaceId: testWorkspaceId("ws2"),
		projectId: testProjectId("p2"),
		sessionId: testSessionId("s1"),
		messageIndex: 3,
		anchorText: "deploy the docs",
	});
	let st = useAppStore.getState();
	expect(st.chatLocationRequest).toEqual({
		workspaceId: testWorkspaceId("ws2"),
		projectId: testProjectId("p2"),
		sessionId: testSessionId("s1"),
		messageIndex: 3,
		anchorText: "deploy the docs",
	});
	expect(st.activeWorkspaceId).toBe(testWorkspaceId("ws2"));
	expect(st.selectedProjectId).toBe(testProjectId("p2"));

	store.clearChatLocation();
	st = useAppStore.getState();
	expect(st.chatLocationRequest).toBeNull();
	expect(st.activeWorkspaceId).toBe(testWorkspaceId("ws2"));
	expect(st.selectedProjectId).toBe(testProjectId("p2"));
});

test("requestChatLocation captures an already-hydrated destination before switching workspaces", () => {
	useAppStore.setState({
		activeWorkspaceId: testWorkspaceId("ws1"),
		layoutAttentionByWorkspace: {
			ws2: {
				selectedByGroup: { destination: "chat" },
				lastFocusedCenterGroupId: "destination",
				lastFocusedSideGroupId: {},
				navigationClockByGroup: { destination: 4 },
			},
		},
	});
	useAppStore.getState().requestChatLocation({
		workspaceId: testWorkspaceId("ws2"),
		projectId: testProjectId("p2"),
		sessionId: testSessionId("session"),
		messageIndex: 1,
		anchorText: "target",
	});
	expect(useAppStore.getState().chatLocationRequest?.navigation).toEqual({
		groupId: "destination",
		clock: 5,
	});
	expect(
		useAppStore.getState().layoutAttentionByWorkspace.ws2?.navigationClockByGroup.destination,
	).toBe(5);
});

function project(over: Partial<Project> = {}): Project {
	return {
		id: testProjectId("p1"),
		name: "Project one",
		path: "/projects/one",
		slug: "project-one",
		lastOpened: 100,
		...over,
	};
}

test("installProjectSnapshot sorts both projections and repairs navigation after an off-screen close", () => {
	const p1 = project();
	const p2 = project({
		id: testProjectId("p2"),
		name: "Project two",
		path: "/projects/two",
		slug: "project-two",
		lastOpened: 200,
		closed: true,
	});
	const workspace = pushedWorkspace({ id: testWorkspaceId("w2"), projectId: testProjectId("p2") });
	const tabs = {
		w2: [
			{
				kind: "file",
				id: "w2:a",
				workspaceId: testWorkspaceId("w2"),
				name: "a",
				path: "a",
				content: "",
			},
		],
	} satisfies Record<string, FileTab[]>;
	useAppStore.setState({
		projects: [p2],
		recentProjects: [p2],
		workspaces: { p2: [workspace] },
		selectedProjectId: testProjectId("p2"),
		activeWorkspaceId: testWorkspaceId("w2"),
		tabsByWorkspace: tabs,
	});

	useAppStore.getState().installProjectSnapshot([p1], [p1, p2]);

	const state = useAppStore.getState();
	expect(state.projects.map((candidate) => candidate.id)).toEqual([testProjectId("p1")]);
	expect(state.recentProjects.map((candidate) => candidate.id)).toEqual([
		testProjectId("p2"),
		testProjectId("p1"),
	]);
	expect(state.selectedProjectId).toBe(testProjectId("p1"));
	expect(state.activeWorkspaceId).toBeNull();
	expect(state.workspaces.p2).toEqual([workspace]);
	expect(state.tabsByWorkspace).toBe(tabs);
});

test("projects-rail expansion: gestures reveal, restore stays neutral, the chevron toggles", () => {
	const p1 = project();
	const p2 = project({
		id: testProjectId("p2"),
		name: "Project two",
		path: "/projects/two",
		slug: "project-two",
	});
	useAppStore.setState({ projects: [p1, p2], recentProjects: [p1, p2] });
	const store = useAppStore.getState();

	store.selectProject(testProjectId("p1"));
	expect(useAppStore.getState().expandedProjectIds).toEqual({});
	store.selectProject(testProjectId("p1"), { reveal: true });
	expect(useAppStore.getState().expandedProjectIds).toEqual({ p1: true });
	const before = useAppStore.getState().expandedProjectIds;
	store.expandProject(testProjectId("p1"));
	expect(useAppStore.getState().expandedProjectIds).toBe(before);
	store.toggleProjectExpanded(testProjectId("p1"));
	expect(useAppStore.getState().expandedProjectIds).toEqual({});
	store.toggleProjectExpanded(testProjectId("p2"));
	expect(useAppStore.getState().expandedProjectIds).toEqual({ p2: true });
	useAppStore.getState().applyProjectUpdated({ ...p2, closed: true });
	expect(useAppStore.getState().expandedProjectIds).toEqual({});
});

test("hydrateExpandedProjects seeds the persisted mirror; the welcome snapshot prunes to the open rail", () => {
	const p1 = project();
	useAppStore
		.getState()
		.hydrateExpandedProjects([testProjectId("p1"), testProjectId("stale-closed-project")]);
	expect(useAppStore.getState().expandedProjectIds).toEqual({
		p1: true,
		"stale-closed-project": true,
	});
	useAppStore.getState().installWelcomeSnapshot(1, [p1], [p1]);
	expect(useAppStore.getState().expandedProjectIds).toEqual({ p1: true });
});

test("applyProjectUpdated closes a background project without moving the current workspace", () => {
	const p1 = project();
	const p2 = project({
		id: testProjectId("p2"),
		name: "Project two",
		path: "/projects/two",
		slug: "project-two",
		lastOpened: 50,
	});
	useAppStore.setState({
		projects: [p1, p2],
		recentProjects: [p1, p2],
		workspaces: { p1: [pushedWorkspace()] },
		selectedProjectId: testProjectId("p1"),
		activeWorkspaceId: testWorkspaceId("w1"),
	});

	useAppStore.getState().applyProjectUpdated({ ...p2, closed: true });

	const state = useAppStore.getState();
	expect(state.projects.map((candidate) => candidate.id)).toEqual([testProjectId("p1")]);
	expect(state.recentProjects.find((candidate) => candidate.id === "p2")?.closed).toBe(true);
	expect(state.selectedProjectId).toBe(testProjectId("p1"));
	expect(state.activeWorkspaceId).toBe(testWorkspaceId("w1"));
});

test("applyProjectUpdated closes the current project to the next Home and preserves its view maps", () => {
	const p1 = project();
	const p2 = project({
		id: testProjectId("p2"),
		name: "Project two",
		path: "/projects/two",
		slug: "project-two",
		lastOpened: 50,
	});
	const workspace = pushedWorkspace();
	const tabs = {
		w1: [
			{
				kind: "file",
				id: "w1:a",
				workspaceId: testWorkspaceId("w1"),
				name: "a",
				path: "a",
				content: "",
			},
		],
	} satisfies Record<string, FileTab[]>;
	useAppStore.setState({
		projects: [p1, p2],
		recentProjects: [p1, p2],
		workspaces: { p1: [workspace] },
		selectedProjectId: testProjectId("p1"),
		activeWorkspaceId: testWorkspaceId("w1"),
		tabsByWorkspace: tabs,
	});

	useAppStore.getState().applyProjectUpdated({ ...p1, closed: true });

	const state = useAppStore.getState();
	expect(state.projects.map((candidate) => candidate.id)).toEqual([testProjectId("p2")]);
	expect(state.selectedProjectId).toBe(testProjectId("p2"));
	expect(state.activeWorkspaceId).toBeNull();
	expect(state.workspaces.p1).toEqual([workspace]);
	expect(state.tabsByWorkspace).toBe(tabs);
});

test("applyProjectUpdated reopens and reorders the same project without duplicating it", () => {
	const p1 = project();
	const closed = project({
		id: testProjectId("p2"),
		name: "Project two",
		path: "/projects/two",
		slug: "project-two",
		lastOpened: 50,
		closed: true,
	});
	useAppStore.setState({ projects: [p1], recentProjects: [p1, closed] });
	const { closed: _closed, ...reopened } = closed;

	useAppStore.getState().applyProjectUpdated({ ...reopened, lastOpened: 200 });

	const state = useAppStore.getState();
	expect(state.projects.map((candidate) => candidate.id)).toEqual([
		testProjectId("p2"),
		testProjectId("p1"),
	]);
	expect(state.recentProjects.map((candidate) => candidate.id)).toEqual([
		testProjectId("p2"),
		testProjectId("p1"),
	]);
	expect(state.projects.filter((candidate) => candidate.id === "p2")).toHaveLength(1);
	expect(state.recentProjects[0]?.closed).toBeUndefined();
});

test("applyProjectUpdated closes the last project to the no-project state", () => {
	const p1 = project();
	useAppStore.setState({
		projects: [p1],
		recentProjects: [p1],
		selectedProjectId: testProjectId("p1"),
		activeWorkspaceId: null,
	});

	useAppStore.getState().applyProjectUpdated({ ...p1, closed: true });

	const state = useAppStore.getState();
	expect(state.projects).toEqual([]);
	expect(state.selectedProjectId).toBeNull();
	expect(state.activeWorkspaceId).toBeNull();
});

function pushedWorkspace(over: Partial<Workspace> = {}): Workspace {
	return {
		id: testWorkspaceId("w1"),
		projectId: testProjectId("p1"),
		name: "add-login-flow",
		branch: "add-login-flow",
		worktreePath: "/tmp/worktrees/p/workspace-1",
		baseBranch: "main",
		renamed: true,
		...over,
	};
}

function selectedChatLayout(sessionId: SessionId): WorkspaceLayoutDocument {
	return {
		version: 2,
		center: {
			kind: "group",
			id: "center",
			tabs: [{ kind: "chat", id: `chat:${sessionId}`, name: "Chat", sessionId }],
		},
		left: { visible: false, width: 0.2, groups: [] },
		right: { visible: false, width: 0.2, groups: [] },
		bottom: emptyBottomRegion(),
		toolRestoreTargets: {},
	};
}

test("project and workspace navigation update both scope ids atomically", () => {
	useAppStore.setState({
		selectedProjectId: testProjectId("p1"),
		activeWorkspaceId: testWorkspaceId("w1"),
	});
	const transitions: [string | null, string | null][] = [];
	const unsubscribe = useAppStore.subscribe((state) => {
		transitions.push([state.selectedProjectId, state.activeWorkspaceId]);
	});

	useAppStore.getState().selectProject(testProjectId("p2"));
	expect(transitions).toEqual([["p2", null]]);

	transitions.length = 0;
	useAppStore
		.getState()
		.activateWorkspace(
			pushedWorkspace({ id: testWorkspaceId("w3"), projectId: testProjectId("p3") }),
		);
	expect(transitions).toEqual([["p3", "w3"]]);
	unsubscribe();
});

test("the selected chat of an entered workspace is attended once layout attention converges", () => {
	const workspace = pushedWorkspace();
	const sessionId = testSessionId("workspace-entry-chat");
	useAppStore.setState({
		layoutDocumentsByWorkspace: { [workspace.id]: selectedChatLayout(sessionId) },
	});
	const attended = () => selectChatAttended(useAppStore.getState(), workspace.id, sessionId);

	const store = useAppStore.getState();
	store.activateWorkspace(workspace);
	expect(attended()).toBe(false);
	store.setLayoutAttention(workspace.id, {
		selectedByGroup: { center: `chat:${sessionId}` },
		lastFocusedCenterGroupId: "center",
		lastFocusedSideGroupId: {},
		navigationClockByGroup: { center: 0 },
	});
	expect(attended()).toBe(true);
	store.setChatObscured(sessionId, true);
	expect(attended()).toBe(false);
	store.setChatObscured(sessionId, false);
	store.selectMain();
	expect(attended()).toBe(false);
});

test("a result marked unread in the attended chat stays held until the chat is left", () => {
	const workspace = pushedWorkspace();
	const sessionId = testSessionId("marked-unread-chat");
	const completionId = "completion:marked";
	useAppStore.setState({
		layoutDocumentsByWorkspace: { [workspace.id]: selectedChatLayout(sessionId) },
	});
	const store = useAppStore.getState();
	store.setStatus("connected");
	store.activateWorkspace(workspace);
	store.setLayoutAttention(workspace.id, {
		selectedByGroup: { center: `chat:${sessionId}` },
		lastFocusedCenterGroupId: "center",
		lastFocusedSideGroupId: {},
		navigationClockByGroup: { center: 0 },
	});
	store.openChatSession(workspace.id, sessionId, null, "medium");
	const record = (completionUnread: boolean): SessionStateRecord => ({
		sessionId,
		workspaceId: workspace.id,
		projectId: workspace.projectId,
		state: {
			execution: "idle",
			runId: "run",
			needsInput: null,
			completion: { completionId, outcome: "succeeded" },
			completionUnread,
			queuedCount: 0,
			backgroundWork: false,
		},
	});
	store.installSessionStateSnapshot([record(false)]);
	store.noteRenderedCompletion(sessionId, completionId);
	const ready = () => selectReadyCompletionAck(useAppStore.getState(), workspace.id, sessionId);

	expect(store.beginMarkWorkspaceUnread(workspace.id)).toBe(true);
	expect(store.beginMarkWorkspaceUnread(workspace.id)).toBe(false);
	store.applySessionState(record(true));
	expect(ready()).toBeNull();
	store.finishMarkWorkspaceUnread(workspace.id, record(true));
	expect(useAppStore.getState().markingUnreadWorkspaces).toEqual({});
	expect(useAppStore.getState().markedUnreadBySession[sessionId]).toMatchObject({ held: true });
	expect(ready()).toBeNull();

	store.setChatObscured(sessionId, true);
	expect(useAppStore.getState().markedUnreadBySession[sessionId]).toMatchObject({ held: false });
	store.setChatObscured(sessionId, false);
	expect(ready()).toBe(completionId);

	store.applySessionState(record(false));
	store.beginMarkWorkspaceUnread(workspace.id);
	expect(useAppStore.getState().markingUnreadWorkspaces[workspace.id]).toEqual({
		candidates: { [sessionId]: completionId },
		attendedSessionId: sessionId,
	});
	store.applySessionState(record(true));
	store.setChatObscured(sessionId, true);
	store.setChatObscured(sessionId, false);
	expect(
		useAppStore.getState().markingUnreadWorkspaces[workspace.id]?.attendedSessionId,
	).toBeNull();
	expect(ready()).toBeNull();
	store.finishMarkWorkspaceUnread(workspace.id, record(true));
	expect(useAppStore.getState().markedUnreadBySession[sessionId]).toMatchObject({ held: false });
	expect(ready()).toBe(completionId);
});

test("a mark started away from a chat never holds it, even if the chat is entered mid-request", () => {
	const workspace = pushedWorkspace();
	const sessionId = testSessionId("entered-mid-mark");
	const completionId = "completion:entered";
	useAppStore.setState({
		layoutDocumentsByWorkspace: { [workspace.id]: selectedChatLayout(sessionId) },
	});
	const store = useAppStore.getState();
	store.setStatus("connected");
	store.activateWorkspace(workspace);
	store.setLayoutAttention(workspace.id, {
		selectedByGroup: { center: `chat:${sessionId}` },
		lastFocusedCenterGroupId: "center",
		lastFocusedSideGroupId: {},
		navigationClockByGroup: { center: 0 },
	});
	const record: SessionStateRecord = {
		sessionId,
		workspaceId: workspace.id,
		projectId: workspace.projectId,
		state: {
			execution: "idle",
			runId: "run",
			needsInput: null,
			completion: { completionId, outcome: "succeeded" },
			completionUnread: false,
			queuedCount: 0,
			backgroundWork: false,
		},
	};
	store.installSessionStateSnapshot([record]);
	store.setChatObscured(sessionId, true);
	store.beginMarkWorkspaceUnread(workspace.id);
	expect(
		useAppStore.getState().markingUnreadWorkspaces[workspace.id]?.attendedSessionId,
	).toBeNull();
	store.setChatObscured(sessionId, false);
	store.finishMarkWorkspaceUnread(workspace.id, {
		...record,
		state: { ...record.state, completionUnread: true },
	});
	expect(useAppStore.getState().markedUnreadBySession[sessionId]).toMatchObject({ held: false });
});

test("workspace selection history tracks ordinary, route, and history-search activation", () => {
	const w1 = pushedWorkspace();
	const w2 = pushedWorkspace({ id: testWorkspaceId("w2"), projectId: testProjectId("p2") });
	useAppStore.setState({
		projects: [project(), project({ id: testProjectId("p2") })],
		workspaces: { p1: [w1], p2: [w2] },
	});

	useAppStore.getState().activateWorkspace(w1);
	useAppStore.getState().activateWorkspace(w2);
	expect(useAppStore.getState().workspaceSelectionHistory).toEqual([
		testWorkspaceId("w2"),
		testWorkspaceId("w1"),
	]);

	useAppStore.getState().activateWorkspaceFromRoute(w1);
	expect(useAppStore.getState().workspaceSelectionHistory).toEqual([
		testWorkspaceId("w1"),
		testWorkspaceId("w2"),
	]);

	useAppStore.getState().requestChatLocation({
		workspaceId: testWorkspaceId("w2"),
		projectId: testProjectId("p2"),
		sessionId: testSessionId("session"),
		messageIndex: 0,
		anchorText: "target",
	});
	expect(useAppStore.getState().workspaceSelectionHistory).toEqual([
		testWorkspaceId("w2"),
		testWorkspaceId("w1"),
	]);

	useAppStore.getState().selectProject(testProjectId("p1"));
	expect(useAppStore.getState().workspaceSelectionHistory).toEqual([
		testWorkspaceId("w2"),
		testWorkspaceId("w1"),
	]);
});

test("installWelcomeSnapshot lands one complete snapshot and advances its own generation", () => {
	const p1 = project();
	const closed = project({
		id: testProjectId("p2"),
		path: "/projects/two",
		slug: "two",
		lastOpened: 50,
		closed: true,
	});
	let notifications = 0;
	const unsubscribe = useAppStore.subscribe((state) => {
		notifications += 1;
		expect(state).toMatchObject({
			protocolVersion: 44,
			theme: "test-theme",
			welcomeGeneration: 1,
		});
		expect(state.projects.map((candidate) => candidate.id)).toEqual([testProjectId("p1")]);
		expect(state.recentProjects.map((candidate) => candidate.id)).toEqual([
			testProjectId("p1"),
			testProjectId("p2"),
		]);
	});

	useAppStore.getState().installWelcomeSnapshot(44, [p1, closed], [p1, closed], {
		...DEFAULT_CONFIG,
		theme: "test-theme",
		analyticsEnabled: false,
		terminalReplayKb: 256,
	});
	unsubscribe();
	expect(notifications).toBe(1);

	useAppStore.getState().installWelcomeSnapshot(44, [p1], [p1]);
	expect(useAppStore.getState().welcomeGeneration).toBe(2);
});

test("welcome replaces and clears the synchronized host update notice", () => {
	useAppStore.getState().installWelcomeSnapshot(62, [], [], undefined, undefined, hostNotice());
	expect(useAppStore.getState().hostUpdate).toEqual(hostNotice());

	useAppStore
		.getState()
		.installWelcomeSnapshot(62, [], [], undefined, undefined, hostNotice("0.3.0"));
	expect(useAppStore.getState().hostUpdate).toEqual(hostNotice("0.3.0"));

	useAppStore.getState().installWelcomeSnapshot(62, [], []);
	expect(useAppStore.getState().hostUpdate).toBeNull();
});

test("the config read notice shows once across welcomes and a good read removes it", () => {
	const store = useAppStore.getState();
	const notices = () =>
		useAppStore.getState().toasts.filter((toast) => toast.message.includes("config.json"));

	store.syncConfigReadNotice(false);
	expect(notices()).toEqual([]);

	store.syncConfigReadNotice(true);
	store.syncConfigReadNotice(true);
	expect(notices()).toHaveLength(1);
	expect(notices()[0]).toMatchObject({
		variant: "warning",
		durationMs: Number.POSITIVE_INFINITY,
	});

	const [shown] = notices();
	if (!shown) throw new Error("the notice was not shown");
	store.dismissToast(shown.id);
	store.syncConfigReadNotice(true);
	expect(notices()).toEqual([]);

	store.syncConfigReadNotice(false);
	store.syncConfigReadNotice(true);
	expect(notices()).toHaveLength(1);
	store.syncConfigReadNotice(false);
	expect(notices()).toEqual([]);
	expect(useAppStore.getState().configReadNoticeId).toBeNull();
});

test("host update pushes replace the same slot with each optional lifecycle snapshot", () => {
	useAppStore.getState().applyHostUpdate(hostNotice("0.2.0", "available"));
	useAppStore.getState().applyHostUpdate(hostNotice("0.2.0", "running"));
	expect(useAppStore.getState().hostUpdate).toEqual(hostNotice("0.2.0", "running"));

	useAppStore.getState().applyHostUpdate(hostNotice("0.2.0", "failed"));
	expect(useAppStore.getState().hostUpdate).toEqual(hostNotice("0.2.0", "failed"));

	useAppStore.getState().applyHostUpdate(hostNotice("0.3.0", "available"));
	expect(useAppStore.getState().hostUpdate).toEqual(hostNotice("0.3.0", "available"));

	useAppStore.getState().applyHostUpdate(hostNotice());
	expect(useAppStore.getState().hostUpdate).toEqual(hostNotice());
});

test("temporary connection changes retain the host update notice until the next welcome", () => {
	useAppStore.getState().installWelcomeSnapshot(62, [], [], undefined, undefined, hostNotice());
	for (const status of ["disconnected", "connecting", "connected"] as const) {
		useAppStore.getState().setStatus(status);
		expect(useAppStore.getState().hostUpdate).toEqual(hostNotice());
	}

	useAppStore.getState().installWelcomeSnapshot(62, [], []);
	expect(useAppStore.getState().hostUpdate).toBeNull();
});

test("installWelcomeSnapshot reconciles stale project navigation", () => {
	const p1 = project();
	useAppStore.setState({
		projects: [project({ id: testProjectId("p2"), path: "/projects/two", slug: "two" })],
		selectedProjectId: testProjectId("p2"),
		activeWorkspaceId: null,
	});

	useAppStore.getState().installWelcomeSnapshot(44, [p1], [p1]);
	expect(useAppStore.getState().selectedProjectId).toBe(testProjectId("p1"));
});

test("activateWorkspaceFromRoute atomically stamps exact-chat intent", () => {
	const workspace = pushedWorkspace();
	useAppStore.setState({ workspaces: { p1: [workspace] }, navTickByWorkspace: { w1: 3 } });

	useAppStore.getState().activateWorkspaceFromRoute(workspace, testSessionId("s1"));
	expect(useAppStore.getState()).toMatchObject({
		selectedProjectId: testProjectId("p1"),
		activeWorkspaceId: testWorkspaceId("w1"),
		routeChatTarget: {
			workspaceId: testWorkspaceId("w1"),
			sessionId: testSessionId("s1"),
			navTick: 4,
			navigation: null,
			validated: false,
		},
		routeChatTargetGeneration: 1,
	});

	useAppStore.getState().activateWorkspaceFromRoute(workspace);
	expect(useAppStore.getState().routeChatTarget).toBeNull();
	expect(selectWorkspaceNavTick(useAppStore.getState(), testWorkspaceId("w1"))).toBe(5);
	expect(useAppStore.getState().routeChatTargetGeneration).toBe(1);
	const before = useAppStore.getState();
	useAppStore.getState().clearRouteChatTarget();
	expect(useAppStore.getState()).toBe(before);
});

test("closeChatToHistory keeps a route target for the closed session", () => {
	const workspace = pushedWorkspace();
	useAppStore.setState({ workspaces: { p1: [workspace] } });
	useAppStore
		.getState()
		.openChatSession(testWorkspaceId("w1"), testSessionId("s1"), null, "medium");
	useAppStore.getState().activateWorkspaceFromRoute(workspace, testSessionId("s1"));
	const target = useAppStore.getState().routeChatTarget;
	expect(target?.sessionId).toBe(testSessionId("s1"));

	useAppStore
		.getState()
		.closeChatToHistory(testSessionId("s1"), false, testWorkspaceId("w1"), false);
	expect(useAppStore.getState().closedChatsByWorkspace.w1?.[0]?.sessionId).toBe(
		testSessionId("s1"),
	);
	expect(useAppStore.getState().routeChatTarget).toBe(target);
});

test("selectCurrentRouteChatTarget rejects overtaken or off-workspace intent", () => {
	const workspace = pushedWorkspace();
	useAppStore.setState({ workspaces: { p1: [workspace] } });
	useAppStore.getState().activateWorkspaceFromRoute(workspace, testSessionId("s1"));
	expect(selectCurrentRouteChatTarget(useAppStore.getState())?.sessionId).toBe(testSessionId("s1"));

	useAppStore.getState().noteNavigation(testWorkspaceId("w1"));
	expect(selectCurrentRouteChatTarget(useAppStore.getState())).toBeNull();

	useAppStore.getState().activateWorkspaceFromRoute(workspace, testSessionId("s1"));
	useAppStore.getState().selectProject(testProjectId("p1"));
	expect(selectCurrentRouteChatTarget(useAppStore.getState())).toBeNull();
});

test("updateWorkspace applies a pushed snapshot authoritatively: dropped fields clear", () => {
	useAppStore.setState({
		workspaces: {
			p1: [
				{
					...pushedWorkspace(),
					diffBase: "release",
					skillOverrides: { "spec-graph": "off" },
					subagentsOverride: "off",
					diffStats: { added: 3, removed: 1 },
				},
			],
		},
	});
	useAppStore.getState().updateWorkspace(pushedWorkspace());

	const ws = useAppStore.getState().workspaces.p1?.[0];
	expect(ws?.diffBase).toBeUndefined();
	expect(ws?.skillOverrides).toBeUndefined();
	expect(ws?.subagentsOverride).toBeUndefined();
	expect(ws?.diffStats).toEqual({ added: 3, removed: 1 });
});

test("updateWorkspace applies the pushed snapshot by id, keeping the computed diffStats aggregate", () => {
	const { renamed: _renamed, ...unrenamed } = pushedWorkspace({
		name: "workspace-1",
		branch: "workspace-1",
	});
	useAppStore.setState({
		workspaces: { p1: [{ ...unrenamed, diffStats: { added: 3, removed: 1 } }] },
	});
	useAppStore.getState().updateWorkspace(pushedWorkspace());

	const ws = useAppStore.getState().workspaces.p1?.[0];
	expect(ws?.name).toBe("add-login-flow");
	expect(ws?.renamed).toBe(true);
	expect(ws?.diffStats).toEqual({ added: 3, removed: 1 });
});

test("updateWorkspace is a no-op for a project whose list was never fetched", () => {
	useAppStore.setState({ workspaces: {} });
	useAppStore.getState().updateWorkspace(pushedWorkspace());
	expect(useAppStore.getState().workspaces).toEqual({});
});

test("updateWorkspace never appends an unknown id to a fetched list", () => {
	const existing = pushedWorkspace({
		id: testWorkspaceId("other"),
		name: "workspace-2",
		branch: "workspace-2",
	});
	useAppStore.setState({ workspaces: { p1: [existing] } });
	useAppStore.getState().updateWorkspace(pushedWorkspace());

	const list = useAppStore.getState().workspaces.p1;
	expect(list).toHaveLength(1);
	expect(list?.[0]?.id).toBe(testWorkspaceId("other"));
});

test("removeWorkspace optimistically drops the row, leaving siblings; unknown project/id is a no-op", () => {
	const keep = pushedWorkspace({
		id: testWorkspaceId("other"),
		name: "workspace-2",
		branch: "workspace-2",
	});
	useAppStore.setState({ workspaces: { p1: [pushedWorkspace(), keep] } });

	useAppStore.getState().removeWorkspace(testProjectId("p1"), testWorkspaceId("w1"));
	expect(useAppStore.getState().workspaces.p1?.map((w) => w.id)).toEqual([
		testWorkspaceId("other"),
	]);

	useAppStore.getState().removeWorkspace(testProjectId("p1"), testWorkspaceId("missing"));
	expect(useAppStore.getState().workspaces.p1).toHaveLength(1);
	useAppStore.getState().removeWorkspace(testProjectId("p2"), testWorkspaceId("w1"));
	expect(useAppStore.getState().workspaces.p2).toBeUndefined();
});

test("addWorkspace upserts into a fetched list (append if absent, merge if present)", () => {
	const other = pushedWorkspace({
		id: testWorkspaceId("other"),
		name: "workspace-2",
		branch: "workspace-2",
	});
	useAppStore.setState({ workspaces: { p1: [other] } });

	useAppStore.getState().addWorkspace(pushedWorkspace());
	expect(useAppStore.getState().workspaces.p1?.map((w) => w.id)).toEqual([
		testWorkspaceId("other"),
		testWorkspaceId("w1"),
	]);

	useAppStore.getState().addWorkspace(pushedWorkspace({ name: "renamed-later" }));
	const list = useAppStore.getState().workspaces.p1;
	expect(list).toHaveLength(2);
	expect(list?.find((w) => w.id === "w1")?.name).toBe("renamed-later");
});

test("addWorkspace is a no-op for a project whose list was never fetched", () => {
	useAppStore.setState({ workspaces: {} });
	useAppStore.getState().addWorkspace(pushedWorkspace());
	expect(useAppStore.getState().workspaces).toEqual({});
});

test("applyWorkspaceRemoved restores the most-recent workspace across projects", () => {
	const removed = pushedWorkspace();
	const previous = pushedWorkspace({
		id: testWorkspaceId("w2"),
		projectId: testProjectId("p2"),
		name: "previous",
	});
	const previousSessionId = testSessionId("passive-fallback-chat");
	useAppStore.setState({
		projects: [project(), project({ id: testProjectId("p2") })],
		workspaces: { p1: [removed], p2: [previous] },
		selectedProjectId: testProjectId("p1"),
		activeWorkspaceId: testWorkspaceId("w1"),
		workspaceSelectionHistory: [testWorkspaceId("w1"), testWorkspaceId("w2")],
		sessionStateByWorkspace: {
			w2: {
				[previousSessionId]: {
					workspaceId: testWorkspaceId("w2"),
					projectId: testProjectId("p2"),
					sessionId: previousSessionId,
					state: {
						execution: "idle",
						runId: "run",
						needsInput: null,
						completion: { completionId: "completion:fallback", outcome: "succeeded" },
						completionUnread: true,
						queuedCount: 0,
						backgroundWork: false,
					},
				},
			},
		},
		layoutDocumentsByWorkspace: { w2: selectedChatLayout(previousSessionId) },
		layoutAttentionByWorkspace: {
			w2: {
				selectedByGroup: { center: `chat:${previousSessionId}` },
				lastFocusedCenterGroupId: "center",
				lastFocusedSideGroupId: {},
				navigationClockByGroup: { center: 0 },
			},
		},
		toasts: [],
	});

	useAppStore.getState().applyWorkspaceRemoved(testProjectId("p1"), testWorkspaceId("w1"));

	const state = useAppStore.getState();
	expect(state.activeWorkspaceId).toBe(testWorkspaceId("w2"));
	expect(state.selectedProjectId).toBe(testProjectId("p2"));
	expect(state.workspaceSelectionHistory).toEqual([testWorkspaceId("w2")]);
	expect(state.toasts).toHaveLength(1);
});

test("applyWorkspaceRemoved skips missing, tombstoned, and closed-project history entries", () => {
	const removed = pushedWorkspace();
	const tombstoned = pushedWorkspace({
		id: testWorkspaceId("tombstoned"),
		projectId: testProjectId("p3"),
	});
	const closed = pushedWorkspace({ id: testWorkspaceId("closed"), projectId: testProjectId("p2") });
	const valid = pushedWorkspace({ id: testWorkspaceId("valid"), projectId: testProjectId("p3") });
	useAppStore.setState({
		projects: [project(), project({ id: testProjectId("p3") })],
		workspaces: { p1: [removed], p2: [closed], p3: [tombstoned, valid] },
		removedWorkspaceIds: { tombstoned: true },
		selectedProjectId: testProjectId("p1"),
		activeWorkspaceId: testWorkspaceId("w1"),
		workspaceSelectionHistory: [
			testWorkspaceId("w1"),
			testWorkspaceId("missing"),
			testWorkspaceId("tombstoned"),
			testWorkspaceId("closed"),
			testWorkspaceId("valid"),
		],
	});

	useAppStore.getState().applyWorkspaceRemoved(testProjectId("p1"), testWorkspaceId("w1"));

	expect(useAppStore.getState().activeWorkspaceId).toBe(testWorkspaceId("valid"));
	expect(useAppStore.getState().selectedProjectId).toBe(testProjectId("p3"));
});

test("applyWorkspaceRemoved drops the row, clears its tabs, and returns the active client to Welcome + toast when history is empty", () => {
	useAppStore.setState({
		workspaces: { p1: [pushedWorkspace()] },
		selectedProjectId: testProjectId("stale-project"),
		activeWorkspaceId: testWorkspaceId("w1"),
		tabsByWorkspace: {
			w1: [
				{
					kind: "file",
					id: "w1:a",
					workspaceId: testWorkspaceId("w1"),
					name: "a",
					path: "a",
					content: "",
				},
			],
		},
		activeTabByWorkspace: { w1: "w1:a" },
		terminalsByWorkspace: {
			w1: [
				{
					tabKey: "terminal-before-removal",
					workspaceId: testWorkspaceId("w1"),
					title: "Terminal",
				},
			],
		},
		changesRequest: { workspaceId: testWorkspaceId("w1"), path: "a", navTick: 0, navigation: null },
		specRequest: { workspaceId: testWorkspaceId("w1"), path: "SPEC.md", navigation: null },
		chatLocationRequest: {
			workspaceId: testWorkspaceId("w1"),
			projectId: testProjectId("p1"),
			sessionId: testSessionId("removed-chat"),
			messageIndex: 0,
			anchorText: "removed",
		},
		historyOpenRequest: { id: "history", sessionId: testSessionId("removed-chat") },
		reviewFocusRequest: {
			workspaceId: testWorkspaceId("w1"),
			commentId: "comment",
			surface: { kind: "diff", scope: { kind: "branch" } },
		},
		closedChatsByWorkspace: {
			w1: [{ sessionId: testSessionId("removed-chat"), title: "Removed", closedAt: 1 }],
		},
		toasts: [],
	});
	let cleanupSubscriberAttempted = false;
	const unsubscribe = useAppStore.subscribe((state, previous) => {
		if (
			cleanupSubscriberAttempted ||
			!previous.terminalsByWorkspace.w1 ||
			state.terminalsByWorkspace.w1
		) {
			return;
		}
		cleanupSubscriberAttempted = true;
		state.setWorkspaceTerminals(testWorkspaceId("w1"), [
			{ tabKey: "late-terminal", title: "Late terminal" },
		]);
	});

	useAppStore.getState().applyWorkspaceRemoved(testProjectId("p1"), testWorkspaceId("w1"));
	unsubscribe();

	const s = useAppStore.getState();
	expect(cleanupSubscriberAttempted).toBe(true);
	expect(s.workspaces.p1).toEqual([]);
	expect(s.tabsByWorkspace.w1).toBeUndefined();
	expect(s.activeWorkspaceId).toBeNull();
	expect(s.selectedProjectId).toBe(testProjectId("p1"));
	expect(s.toasts).toHaveLength(1);
	expect(s.toasts[0]?.message).toContain("add-login-flow");
	expect(s.changesRequest).toBeNull();
	expect(s.specRequest).toBeNull();
	expect(s.chatLocationRequest).toBeNull();
	expect(s.historyOpenRequest).toBeNull();
	expect(s.reviewFocusRequest).toBeNull();

	s.setLayoutAttention(testWorkspaceId("w1"), {
		selectedByGroup: {},
		lastFocusedCenterGroupId: "center",
		lastFocusedSideGroupId: {},
		navigationClockByGroup: { center: 0 },
	});
	s.openTab(
		{
			kind: "file",
			id: "late-file",
			workspaceId: testWorkspaceId("w1"),
			name: "late",
			path: "late",
			content: "",
		},
		"keep",
	);
	s.setWorkspaceTerminals(testWorkspaceId("w1"), [
		{ tabKey: "late-terminal", title: "Late terminal" },
	]);
	s.closeTerminalTab(testWorkspaceId("w1"), "late-terminal");
	s.setWorkspaceSpecs(testWorkspaceId("w1"), []);
	s.noteFsChanged({
		workspaceId: testWorkspaceId("w1"),
		paths: ["late"],
		truncated: false,
		skillChange: "none",
	});
	s.requestToolView(testWorkspaceId("w1"), "files");
	s.reconcileWorkspaceSessions(testWorkspaceId("w1"), [testSessionId("removed-chat")], []);
	s.noteClosedChats(testWorkspaceId("w1"), [
		{ sessionId: testSessionId("late-chat"), title: "Late", closedAt: 2 },
	]);
	s.requestChatLocation({
		workspaceId: testWorkspaceId("w1"),
		projectId: testProjectId("p1"),
		sessionId: testSessionId("late-chat"),
		messageIndex: 0,
		anchorText: "late",
	});
	s.activateWorkspace(pushedWorkspace());
	s.setWorkspaces(testProjectId("p1"), [pushedWorkspace()]);
	const afterLateArrivals = useAppStore.getState();
	expect(afterLateArrivals.layoutDocumentsByWorkspace.w1).toBeUndefined();
	expect(afterLateArrivals.layoutAttentionByWorkspace.w1).toBeUndefined();
	expect(afterLateArrivals.layoutIntents).toEqual([]);
	expect(afterLateArrivals.tabsByWorkspace.w1).toBeUndefined();
	expect(afterLateArrivals.closedChatsByWorkspace.w1).toBeUndefined();
	expect(afterLateArrivals.terminalsByWorkspace.w1).toBeUndefined();
	expect(afterLateArrivals.specsByWorkspace.w1).toBeUndefined();
	expect(afterLateArrivals.fsChangesByWorkspace.w1).toBeUndefined();
	expect(afterLateArrivals.chatLocationRequest).toBeNull();
	expect(afterLateArrivals.activeWorkspaceId).toBeNull();
	expect(afterLateArrivals.workspaces.p1).toEqual([]);
});

test("applyWorkspaceRemoved on a non-active workspace drops the row silently (no toast, active untouched)", () => {
	const keep = pushedWorkspace({
		id: testWorkspaceId("other"),
		name: "workspace-2",
		branch: "workspace-2",
	});
	useAppStore.setState({
		workspaces: { p1: [pushedWorkspace(), keep] },
		activeWorkspaceId: testWorkspaceId("other"),
		workspaceSelectionHistory: [testWorkspaceId("other"), testWorkspaceId("w1")],
		toasts: [],
	});

	useAppStore.getState().applyWorkspaceRemoved(testProjectId("p1"), testWorkspaceId("w1"));

	const s = useAppStore.getState();
	expect(s.workspaces.p1?.map((w) => w.id)).toEqual([testWorkspaceId("other")]);
	expect(s.activeWorkspaceId).toBe(testWorkspaceId("other"));
	expect(s.workspaceSelectionHistory).toEqual([testWorkspaceId("other")]);
	expect(s.toasts).toHaveLength(0);
});

test("applyWorkspaceRemoved drops the removed workspace's cached spec graph", () => {
	const keep = pushedWorkspace({
		id: testWorkspaceId("other"),
		name: "workspace-2",
		branch: "workspace-2",
	});
	useAppStore.setState({
		workspaces: { p1: [pushedWorkspace(), keep] },
		activeWorkspaceId: testWorkspaceId("other"),
		specsByWorkspace: { w1: [], other: [] },
		toasts: [],
	});

	useAppStore.getState().applyWorkspaceRemoved(testProjectId("p1"), testWorkspaceId("w1"));

	const s = useAppStore.getState();
	expect(s.specsByWorkspace.w1).toBeUndefined();
	expect(s.specsByWorkspace.other).toEqual([]);
});

test("files tree state keeps per-workspace folders and scroll, and drops a removed workspace", () => {
	useAppStore.setState({
		filesTreeByWorkspace: {},
		removedWorkspaceIds: nullProto<Record<string, true>>(),
		workspaces: { p1: [pushedWorkspace()] },
	});
	const view = () => selectFilesTreeView(useAppStore.getState(), testWorkspaceId("w1"));
	const store = useAppStore.getState();

	store.setFilesTreeExpanded(testWorkspaceId("w1"), ["src", "src/auth"], true);
	const expanded = view().expanded;
	store.setFilesTreeExpanded(testWorkspaceId("w1"), ["src"], true);
	expect(view().expanded).toBe(expanded);
	store.setFilesTreeExpanded(testWorkspaceId("w1"), ["src/auth"], false);
	expect(view().expanded).toEqual(["src"]);
	store.collapseAllFiles(testWorkspaceId("w1"));
	expect(view().expanded).toEqual([]);

	store.setChangedTreeCollapsed(testWorkspaceId("w1"), ["apps/web"], true);
	store.setFilesTreeScroll(testWorkspaceId("w1"), "changedTree", 120, "branch");
	expect(view()).toMatchObject({
		changedCollapsed: ["apps/web"],
		scroll: { changedTree: { top: 120, scope: "branch" } },
	});
	expect(selectFilesTreeView(useAppStore.getState(), testWorkspaceId("w2")).expanded).toEqual([]);

	useAppStore.getState().applyWorkspaceRemoved(testProjectId("p1"), testWorkspaceId("w1"));
	expect(useAppStore.getState().filesTreeByWorkspace.w1).toBeUndefined();
	useAppStore.getState().setFilesTreeExpanded(testWorkspaceId("w1"), ["src"], true);
	expect(useAppStore.getState().filesTreeByWorkspace.w1).toBeUndefined();
});

test("revealInFiles expands every ancestor folder and records the revealed file", () => {
	useAppStore.setState({
		filesTreeByWorkspace: {},
		removedWorkspaceIds: nullProto<Record<string, true>>(),
	});
	useAppStore.getState().setFilesTreeExpanded(testWorkspaceId("w1"), ["docs"], true);
	useAppStore.getState().revealInFiles(testWorkspaceId("w1"), "src/auth/login.ts");
	const view = selectFilesTreeView(useAppStore.getState(), testWorkspaceId("w1"));
	expect(view.expanded).toEqual(["docs", "src", "src/auth"]);
	expect(view.seenActivePath).toBe("src/auth/login.ts");
	useAppStore.getState().revealInFiles(testWorkspaceId("w1"), "src/auth/login.ts");
	expect(selectFilesTreeView(useAppStore.getState(), testWorkspaceId("w1"))).toBe(view);
});

test("selectActiveFilePath follows the active file tab and ignores other tabs", () => {
	const file: FileTab = {
		kind: "file",
		id: "f",
		workspaceId: testWorkspaceId("w1"),
		name: "a",
		path: "./src/a.ts",
		content: "",
	};
	const tabsByWorkspace = { w1: [file] };
	expect(
		selectActiveFilePath(
			{ tabsByWorkspace, activeTabByWorkspace: { w1: "f" } },
			testWorkspaceId("w1"),
		),
	).toBe("src/a.ts");
	expect(
		selectActiveFilePath(
			{ tabsByWorkspace, activeTabByWorkspace: { w1: "chat" } },
			testWorkspaceId("w1"),
		),
	).toBeNull();
});

test("revealChanges and requestChangesView reveal Files in Changed mode", () => {
	useAppStore.setState({ filesMode: "all", layoutIntents: [] });
	useAppStore.getState().revealChanges(testWorkspaceId("w1"));
	expect(useAppStore.getState().filesMode).toBe("changed");
	expect(useAppStore.getState().layoutIntents).toMatchObject([
		{ kind: "reveal-tool", workspaceId: testWorkspaceId("w1"), tool: "files" },
	]);

	useAppStore.setState({ filesMode: "all", layoutIntents: [] });
	useAppStore.getState().requestChangesView(testWorkspaceId("w1"), null);
	expect(useAppStore.getState().filesMode).toBe("changed");
});

test("requestChangesView / requestSpecView pair independent path requests with reveal intents", () => {
	useAppStore.setState({ changesRequest: null, specRequest: null, layoutIntents: [] });

	useAppStore.getState().requestChangesView(testWorkspaceId("w1"), "src/a.ts");
	useAppStore.getState().requestSpecView(testWorkspaceId("w1"), ".thinkrail/context/TASK-x.md");

	const s = useAppStore.getState();
	expect(s.changesRequest).toEqual({
		workspaceId: testWorkspaceId("w1"),
		path: "src/a.ts",
		navTick: 1,
		navigation: null,
	});
	expect(s.specRequest).toEqual({
		workspaceId: testWorkspaceId("w1"),
		path: ".thinkrail/context/TASK-x.md",
		navigation: null,
	});
	expect(
		s.layoutIntents.map(({ kind, workspaceId, ...intent }) => ({ kind, workspaceId, ...intent })),
	).toMatchObject([
		{ kind: "reveal-tool", workspaceId: testWorkspaceId("w1"), tool: "files" },
		{ kind: "reveal-tool", workspaceId: testWorkspaceId("w1"), tool: "specs" },
	]);

	const first = useAppStore.getState().specRequest;
	useAppStore.getState().requestSpecView(testWorkspaceId("w1"), ".thinkrail/context/TASK-x.md");
	expect(useAppStore.getState().specRequest).not.toBe(first);
	expect(useAppStore.getState().specRequest).toEqual(first);
});

test("requestToolView reveals a tool without fabricating a path request", () => {
	useAppStore.setState({ layoutIntents: [], changesRequest: null, specRequest: null });

	useAppStore.getState().requestToolView(testWorkspaceId("w1"), "specs");

	const first = useAppStore.getState().layoutIntents[0];
	expect(first).toMatchObject({
		kind: "reveal-tool",
		workspaceId: testWorkspaceId("w1"),
		tool: "specs",
	});
	expect(useAppStore.getState().specRequest).toBeNull();
	expect(useAppStore.getState().changesRequest).toBeNull();

	useAppStore.getState().requestToolView(testWorkspaceId("w1"), "specs");
	const second = useAppStore.getState().layoutIntents[1];
	expect(second).toMatchObject({
		kind: "reveal-tool",
		workspaceId: testWorkspaceId("w1"),
		tool: "specs",
	});
	expect(second?.id).not.toBe(first?.id);
});

test("clearSpecRequest consumes the spec intent once — it opens a tab, so it must not replay", () => {
	useAppStore.setState({ specRequest: null, changesRequest: null });
	useAppStore.getState().requestSpecView(testWorkspaceId("w1"), "docs/SPEC.md");

	useAppStore.getState().clearSpecRequest();

	expect(useAppStore.getState().specRequest).toBeNull();
	useAppStore.getState().clearSpecRequest();
	expect(useAppStore.getState().specRequest).toBeNull();
	useAppStore.getState().requestChangesView(testWorkspaceId("w1"), "src/a.ts");
	useAppStore.getState().clearSpecRequest();
	expect(useAppStore.getState().changesRequest).toEqual({
		workspaceId: testWorkspaceId("w1"),
		path: "src/a.ts",
		navTick: 2,
		navigation: null,
	});
});

test("the Changes deep link stamps the nav count at the click, so a later navigation still wins", () => {
	useAppStore.setState({
		activeWorkspaceId: testWorkspaceId("ws1"),
		changesRequest: null,
		layoutIntents: [],
	});
	const s = () => useAppStore.getState();

	s().openTab(fileTab(testWorkspaceId("ws1"), "a.ts"), "keep");
	s().setActiveTab("ws1:a.ts");
	const beforeClick = selectWorkspaceNavTick(s(), testWorkspaceId("ws1"));

	s().requestChangesView(testWorkspaceId("ws1"), "src/b.ts");
	const request = s().changesRequest;
	if (!request) throw new Error("expected a changes request");
	expect(request.navTick).toBe(beforeClick + 1);

	expect(selectWorkspaceNavTick(s(), testWorkspaceId("ws1"))).toBe(request.navTick);

	s().setActiveTab("ws1:a.ts");
	expect(selectWorkspaceNavTick(s(), testWorkspaceId("ws1"))).not.toBe(request.navTick);
});

test("legacy selection reconciliation does not count as user navigation", () => {
	useAppStore.setState({
		tabsByWorkspace: {
			ws1: [fileTab(testWorkspaceId("ws1"), "a.ts"), fileTab(testWorkspaceId("ws1"), "b.ts")],
		},
		activeTabByWorkspace: { ws1: "ws1:a.ts" },
		navTickByWorkspace: { ws1: 7 },
	});
	useAppStore
		.getState()
		.syncLegacySelection(testWorkspaceId("ws1"), { kind: "editor", tabId: "ws1:b.ts" });
	expect(useAppStore.getState().activeTabByWorkspace.ws1).toBe("ws1:b.ts");
	expect(useAppStore.getState().activeTerminalByWorkspace.ws1).toBeNull();
	expect(useAppStore.getState().navTickByWorkspace.ws1).toBe(7);

	useAppStore.setState({
		terminalsByWorkspace: {
			ws1: [{ tabKey: "terminal", workspaceId: testWorkspaceId("ws1"), title: "Terminal" }],
		},
	});
	useAppStore.getState().syncLegacySelection(testWorkspaceId("ws1"), {
		kind: "terminal",
		tabKey: "terminal",
	});
	expect(useAppStore.getState().activeTabByWorkspace.ws1).toBeNull();
	expect(useAppStore.getState().activeTerminalByWorkspace.ws1).toBe("terminal");
	useAppStore.getState().syncLegacySelection(testWorkspaceId("ws1"), null);
	expect(useAppStore.getState().activeTabByWorkspace.ws1).toBeNull();
	expect(useAppStore.getState().activeTerminalByWorkspace.ws1).toBeNull();
	expect(useAppStore.getState().navTickByWorkspace.ws1).toBe(7);
});

test("deferred center navigation clocks are isolated by destination group", () => {
	useAppStore.setState({
		activeWorkspaceId: testWorkspaceId("ws1"),
		layoutAttentionByWorkspace: {
			ws1: {
				selectedByGroup: { a: "file-a", b: "file-b" },
				lastFocusedCenterGroupId: "a",
				lastFocusedSideGroupId: {},
				navigationClockByGroup: { a: 4, b: 9 },
			},
		},
	});

	const passive = captureCenterNavigation(useAppStore.getState(), testWorkspaceId("ws1"));
	expect(passive).toEqual({ groupId: "a", clock: 4 });
	const fromA = useAppStore.getState().beginCenterNavigation(testWorkspaceId("ws1"));
	expect(fromA).toEqual({ groupId: "a", clock: 5 });
	expect(isCenterNavigationCurrent(useAppStore.getState(), testWorkspaceId("ws1"), fromA)).toBe(
		true,
	);
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws2") });
	expect(
		layoutOpenOptionsForNavigation(useAppStore.getState(), testWorkspaceId("ws1"), fromA),
	).toEqual({
		targetGroupId: "a",
		activate: false,
		navigation: fromA,
	});
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws1") });

	useAppStore.getState().beginCenterNavigation(testWorkspaceId("ws1"), "b");
	expect(isCenterNavigationCurrent(useAppStore.getState(), testWorkspaceId("ws1"), fromA)).toBe(
		true,
	);
	expect(
		layoutOpenOptionsForNavigation(useAppStore.getState(), testWorkspaceId("ws1"), fromA),
	).toEqual({
		targetGroupId: "a",
		activate: false,
		navigation: fromA,
	});
	const withOtherGroupFocused = useAppStore.getState().layoutAttentionByWorkspace.ws1;
	if (!withOtherGroupFocused) throw new Error("missing attention fixture");
	expect(shouldAdvanceAcceptedNavigation(withOtherGroupFocused, fromA)).toBe(false);

	useAppStore.getState().beginCenterNavigation(testWorkspaceId("ws1"), "a");
	expect(isCenterNavigationCurrent(useAppStore.getState(), testWorkspaceId("ws1"), fromA)).toBe(
		false,
	);

	const withoutA = useAppStore.getState().layoutAttentionByWorkspace.ws1;
	if (!withoutA) throw new Error("missing attention fixture");
	const onlyB = {
		...withoutA,
		navigationClockByGroup: { b: withoutA.navigationClockByGroup.b ?? 0 },
	};
	useAppStore.setState({ layoutAttentionByWorkspace: { ws1: onlyB } });
	expect(
		layoutOpenOptionsForNavigation(useAppStore.getState(), testWorkspaceId("ws1"), fromA),
	).toEqual({
		targetGroupId: "a",
		navigation: fromA,
	});
	expect(shouldAdvanceAcceptedNavigation(onlyB, fromA)).toBe(true);
	const rerouted = useAppStore
		.getState()
		.beginCenterNavigation(testWorkspaceId("ws1"), "removed-group");
	expect(rerouted?.groupId).toBe("b");
	expect(
		Object.hasOwn(
			useAppStore.getState().layoutAttentionByWorkspace.ws1?.navigationClockByGroup ?? {},
			"removed-group",
		),
	).toBe(false);
});

test("a request-time center navigation is not counted again when its chat cache lands", () => {
	useAppStore.setState({
		activeWorkspaceId: testWorkspaceId("ws1"),
		layoutAttentionByWorkspace: {
			ws1: {
				selectedByGroup: {},
				lastFocusedCenterGroupId: "center",
				lastFocusedSideGroupId: {},
				navigationClockByGroup: { center: 3 },
			},
		},
		navTickByWorkspace: { ws1: 7 },
	});
	const navigation = useAppStore.getState().beginCenterNavigation(testWorkspaceId("ws1"));
	const afterRequest = useAppStore.getState().navTickByWorkspace.ws1;
	useAppStore
		.getState()
		.openChatSession(
			testWorkspaceId("ws1"),
			testSessionId("session-requested"),
			null,
			"medium",
			undefined,
			layoutOpenOptionsForNavigation(useAppStore.getState(), testWorkspaceId("ws1"), navigation),
		);

	expect(useAppStore.getState().navTickByWorkspace.ws1).toBe(afterRequest);
	expect(useAppStore.getState().layoutIntents.at(-1)).toMatchObject({
		kind: "open",
		navigation,
	});
});

test("clearChangesRequest consumes the Changes intent once — it opens a diff tab, so it must not replay", () => {
	useAppStore.setState({ specRequest: null, changesRequest: null });
	useAppStore.getState().requestChangesView(testWorkspaceId("w1"), "src/a.ts");

	useAppStore.getState().clearChangesRequest();

	expect(useAppStore.getState().changesRequest).toBeNull();
	useAppStore.getState().requestSpecView(testWorkspaceId("w1"), "docs/SPEC.md");
	useAppStore.getState().clearChangesRequest();
	expect(useAppStore.getState().changesRequest).toBeNull();
	expect(useAppStore.getState().specRequest).toEqual({
		workspaceId: testWorkspaceId("w1"),
		path: "docs/SPEC.md",
		navigation: null,
	});
});

const specNode = (over: Partial<SpecGraphNode> = {}): SpecGraphNode => ({
	id: "task-x",
	type: "task-spec",
	title: "X",
	path: ".thinkrail/context/TASK-x.md",
	dependsOn: [],
	references: [],
	implements: [],
	tags: [],
	...over,
});

test("setWorkspaceSpecs records a snapshot per workspace without touching its siblings", () => {
	const node = specNode();
	useAppStore.setState({ specsByWorkspace: { other: [] } });

	useAppStore.getState().setWorkspaceSpecs(testWorkspaceId("w1"), [node]);

	const s = useAppStore.getState();
	expect(s.specsByWorkspace.w1).toEqual([node]);
	expect(s.specsByWorkspace.other).toEqual([]);
});

test("setWorkspaceSpecs keeps the previous array identity when the re-read found no change", () => {
	useAppStore.setState({ specsByWorkspace: {} });
	useAppStore.getState().setWorkspaceSpecs(testWorkspaceId("w1"), [specNode()]);
	const first = useAppStore.getState().specsByWorkspace.w1;

	useAppStore.getState().setWorkspaceSpecs(testWorkspaceId("w1"), [specNode()]);
	expect(useAppStore.getState().specsByWorkspace.w1).toBe(first);

	useAppStore.getState().setWorkspaceSpecs(testWorkspaceId("w1"), [specNode({ status: "active" })]);
	expect(useAppStore.getState().specsByWorkspace.w1).not.toBe(first);

	const withStatus = useAppStore.getState().specsByWorkspace.w1;
	useAppStore
		.getState()
		.setWorkspaceSpecs(testWorkspaceId("w1"), [specNode({ status: "active", tags: ["v1"] })]);
	expect(useAppStore.getState().specsByWorkspace.w1).not.toBe(withStatus);

	useAppStore.getState().setWorkspaceSpecs(testWorkspaceId("w1"), []);
	expect(useAppStore.getState().specsByWorkspace.w1).toEqual([]);
});

test("beginLogin opens a fresh active login; frames accumulate (url + paste prompt coexist)", () => {
	const s = useAppStore.getState();
	s.beginLogin("l1", "anthropic");
	expect(useAppStore.getState().activeLogin).toEqual({
		loginId: "l1",
		providerId: "anthropic",
		status: "active",
	});

	s.applyLoginFrame({
		loginId: "l1",
		providerId: "anthropic",
		frame: { kind: "authUrl", url: "https://x/auth" },
	});
	s.applyLoginFrame({
		loginId: "l1",
		providerId: "anthropic",
		frame: { kind: "prompt", message: "Paste the code", placeholder: "code" },
	});
	expect(useAppStore.getState().activeLogin).toMatchObject({
		url: "https://x/auth",
		input: { kind: "prompt", message: "Paste the code", placeholder: "code" },
	});
});

test("a prompt frame's allowEmpty folds through (Copilot's blank-for-github.com GHE prompt)", () => {
	const s = useAppStore.getState();
	s.beginLogin("l1", "github-copilot");
	s.applyLoginFrame({
		loginId: "l1",
		providerId: "github-copilot",
		frame: {
			kind: "prompt",
			message: "GitHub Enterprise URL/domain (blank for github.com)",
			placeholder: "company.ghe.com",
			allowEmpty: true,
		},
	});
	expect(useAppStore.getState().activeLogin?.input).toMatchObject({
		kind: "prompt",
		allowEmpty: true,
	});
});

test("a frame that beats the loginStart response creates the login; beginLogin then no-ops", () => {
	const s = useAppStore.getState();
	s.applyLoginFrame({
		loginId: "l9",
		providerId: "openai-codex",
		frame: { kind: "authUrl", url: "https://y" },
	});
	expect(useAppStore.getState().activeLogin).toMatchObject({ loginId: "l9", url: "https://y" });

	s.beginLogin("l9", "openai-codex");
	expect(useAppStore.getState().activeLogin).toMatchObject({ loginId: "l9", url: "https://y" });
});

test("frames for a different still-active login are ignored (modal — one at a time)", () => {
	const s = useAppStore.getState();
	s.beginLogin("l1", "anthropic");
	s.applyLoginFrame({
		loginId: "other",
		providerId: "google",
		frame: { kind: "authUrl", url: "https://nope" },
	});
	expect(useAppStore.getState().activeLogin).toMatchObject({
		loginId: "l1",
		providerId: "anthropic",
	});
	expect(useAppStore.getState().activeLogin?.url).toBeUndefined();
});

test("clearLoginInput drops the live input; success is terminal; clearLogin dismisses", () => {
	const s = useAppStore.getState();
	s.beginLogin("l1", "anthropic");
	s.applyLoginFrame({
		loginId: "l1",
		providerId: "anthropic",
		frame: { kind: "select", message: "Pick", options: [{ id: "max", label: "Max" }] },
	});
	expect(useAppStore.getState().activeLogin?.input).toBeDefined();

	s.clearLoginInput();
	expect(useAppStore.getState().activeLogin?.input).toBeUndefined();

	s.applyLoginFrame({ loginId: "l1", providerId: "anthropic", frame: { kind: "success" } });
	expect(useAppStore.getState().activeLogin?.status).toBe("success");

	s.clearLogin();
	expect(useAppStore.getState().activeLogin).toBeNull();
});

test("openSettings deep-links to a section (default providers); closeSettings hides it", () => {
	const s = useAppStore.getState();
	s.openSettings();
	expect(useAppStore.getState().settingsOpen).toBe(true);
	expect(useAppStore.getState().settingsSection).toBe("providers");

	s.openSettings("github");
	expect(useAppStore.getState().settingsSection).toBe("github");

	s.setSettingsSection("providers");
	expect(useAppStore.getState().settingsSection).toBe("providers");

	s.closeSettings();
	expect(useAppStore.getState().settingsOpen).toBe(false);
	expect(useAppStore.getState().settingsSection).toBe("providers");
});

test("the survey invitation show action is idempotent and hide clears it", () => {
	let updates = 0;
	const unsubscribe = useAppStore.subscribe(() => {
		updates += 1;
	});

	useAppStore.getState().showSurveyInvitation();
	useAppStore.getState().showSurveyInvitation();
	expect(useAppStore.getState().surveyInvitationOpen).toBe(true);
	expect(updates).toBe(1);

	useAppStore.getState().hideSurveyInvitation();
	expect(useAppStore.getState().surveyInvitationOpen).toBe(false);
	expect(updates).toBe(2);
	unsubscribe();
});

test("opening the survey window closes the invitation and Settings in one update", () => {
	useAppStore.setState({ surveyInvitationOpen: true, settingsOpen: true });
	let updates = 0;
	const unsubscribe = useAppStore.subscribe(() => {
		updates += 1;
	});
	useAppStore.getState().openSurveyWindow();
	expect(useAppStore.getState()).toMatchObject({
		surveyWindowOpen: true,
		surveyInvitationOpen: false,
		settingsOpen: false,
	});
	expect(updates).toBe(1);
	useAppStore.getState().closeSurveyWindow();
	expect(useAppStore.getState().surveyWindowOpen).toBe(false);
	unsubscribe();
});

test("an error frame is terminal: sets status/error and clears the live input + progress", () => {
	const s = useAppStore.getState();
	s.beginLogin("l1", "anthropic");
	s.applyLoginFrame({
		loginId: "l1",
		providerId: "anthropic",
		frame: { kind: "progress", message: "…" },
	});
	s.applyLoginFrame({
		loginId: "l1",
		providerId: "anthropic",
		frame: { kind: "prompt", message: "code" },
	});
	s.applyLoginFrame({
		loginId: "l1",
		providerId: "anthropic",
		frame: { kind: "error", message: "Scope revoked by provider" },
	});
	const login = useAppStore.getState().activeLogin;
	expect(login).toMatchObject({ status: "error", error: "Scope revoked by provider" });
	expect(login?.input).toBeUndefined();
	expect(login?.progress).toBeUndefined();
});

test("pushToast appends with a fresh id and dismissToast removes only that toast", () => {
	const store = useAppStore.getState();
	const id1 = store.pushToast({ variant: "error", message: "boom" });
	const id2 = store.pushToast({ variant: "info", message: "fyi", title: "Heads up" });
	expect(id1).not.toBe(id2);
	expect(useAppStore.getState().toasts).toMatchObject([
		{ id: id1, variant: "error", message: "boom" },
		{ id: id2, variant: "info", message: "fyi", title: "Heads up" },
	]);
	expect(useAppStore.getState().toasts[0]).not.toHaveProperty("title");

	store.dismissToast(id1);
	expect(useAppStore.getState().toasts).toMatchObject([{ id: id2 }]);
});

test("dismissToast for an unknown id is a no-op (same array ref, no churn)", () => {
	const store = useAppStore.getState();
	store.pushToast({ variant: "success", message: "done" });
	const before = useAppStore.getState().toasts;
	store.dismissToast("ghost");
	expect(useAppStore.getState().toasts).toBe(before);
});

test("pushToast coalesces an identical live actionless toast", () => {
	const store = useAppStore.getState();
	const id1 = store.pushToast({ variant: "error", message: "boom", title: "Failed" });
	const twin = store.pushToast({ variant: "error", message: "boom", title: "Failed" });
	expect(twin).toBe(id1);
	expect(useAppStore.getState().toasts).toHaveLength(1);

	store.pushToast({ variant: "info", message: "boom", title: "Failed" });
	store.pushToast({ variant: "error", message: "boom" });
	expect(useAppStore.getState().toasts).toHaveLength(3);

	store.dismissToast(id1);
	const fresh = store.pushToast({ variant: "error", message: "boom", title: "Failed" });
	expect(fresh).not.toBe(id1);
	expect(useAppStore.getState().toasts).toHaveLength(3);
});

test("actionable toasts retain their inverse and never coalesce", () => {
	const store = useAppStore.getState();
	let calls = 0;
	const first = store.pushToast({
		variant: "success",
		message: "Reverted hunk",
		durationMs: 8000,
		action: { label: "Undo", onClick: () => calls++ },
	});
	const second = store.pushToast({
		variant: "success",
		message: "Reverted hunk",
		durationMs: 8000,
		action: { label: "Undo", onClick: () => calls++ },
	});
	expect(second).not.toBe(first);
	expect(useAppStore.getState().toasts).toHaveLength(2);
	useAppStore.getState().toasts[0]?.action?.onClick();
	expect(calls).toBe(1);
});

test("six revert receipts keep all Undo actions and cap a seventh actionless toast", () => {
	const store = useAppStore.getState();
	for (let index = 0; index < 6; index++) {
		store.pushToast({
			variant: "success",
			message: `Reverted hunk ${index}`,
			durationMs: 8000,
			action: { label: "Undo", onClick: () => {} },
		});
	}
	expect(useAppStore.getState().toasts).toHaveLength(6);
	expect(
		useAppStore.getState().toasts.every((candidate) => candidate.action?.label === "Undo"),
	).toBe(true);

	store.pushToast({ variant: "info", message: "Actionless" });
	const toasts = useAppStore.getState().toasts;
	expect(toasts).toHaveLength(6);
	expect(toasts.some((candidate) => candidate.message === "Actionless")).toBe(false);
});

test("pushToast caps actionless notifications, dropping the oldest", () => {
	const store = useAppStore.getState();
	const first = store.pushToast({ variant: "error", message: "toast 0" });
	for (let i = 1; i <= 5; i++) store.pushToast({ variant: "error", message: `toast ${i}` });
	const toasts = useAppStore.getState().toasts;
	expect(toasts).toHaveLength(5);
	expect(toasts.some((t) => t.id === first)).toBe(false);
	expect(toasts[0]?.message).toBe("toast 1");
	expect(toasts[4]?.message).toBe("toast 5");
});

test("the toast helper enqueues by variant and omits an absent title", () => {
	toast.success("saved");
	toast.error("nope", "Failed");
	expect(useAppStore.getState().toasts).toMatchObject([
		{ variant: "success", message: "saved" },
		{ variant: "error", message: "nope", title: "Failed" },
	]);
	expect(useAppStore.getState().toasts[0]).not.toHaveProperty("title");
});

test("applyConfig folds and normalizes the server-synced theme preference", () => {
	const pair = { light: "acme.light", dark: "acme.dark" };
	useAppStore.getState().applyConfig({
		...DEFAULT_CONFIG,
		theme: "acme.fixed",
		themeMode: "system",
		systemThemePair: pair,
	});
	expect(useAppStore.getState()).toMatchObject({
		theme: "acme.fixed",
		themeMode: "system",
		systemThemePair: pair,
	});

	useAppStore.getState().applyConfig({
		...DEFAULT_CONFIG,
		theme: "legacy.fixed",
		themeMode: "future",
		systemThemePair: { light: "only-light" },
	} as unknown as AppConfig);
	expect(useAppStore.getState()).toMatchObject({
		theme: "legacy.fixed",
		themeMode: "fixed",
		systemThemePair: undefined,
	});
});

test("applyConfig projects and validates the Windows terminal shell", () => {
	useAppStore.getState().applyConfig({
		...DEFAULT_CONFIG,
		terminalWindowsShell: "cmd",
	});
	expect(useAppStore.getState()).toHaveProperty("terminalWindowsShell", "cmd");

	useAppStore.getState().applyConfig({
		...DEFAULT_CONFIG,
		terminalWindowsShell: "future-shell",
	} as unknown as AppConfig);
	expect(useAppStore.getState()).toHaveProperty(
		"terminalWindowsShell",
		DEFAULT_CONFIG.terminalWindowsShell,
	);
});

test("applyConfig projects the composer growth limit", () => {
	useAppStore.getState().applyConfig({
		...DEFAULT_CONFIG,
		composerGrowthLimit: "roomy",
	});
	expect(useAppStore.getState()).toHaveProperty("composerGrowthLimit", "roomy");
});

test("applyConfig projects synchronized chat and file line-width settings", () => {
	useAppStore.getState().applyConfig({
		...DEFAULT_CONFIG,
		chatLineWidth: 84,
		fileLineWidth: 156,
		chatLineWidthBounded: false,
		fileLineWidthBounded: true,
	});
	expect(useAppStore.getState()).toMatchObject({
		chatLineWidth: 84,
		fileLineWidth: 156,
		chatLineWidthBounded: false,
		fileLineWidthBounded: true,
	});
});

test("applyConfig defaults absent or malformed line-width fields independently", () => {
	const config = {
		...DEFAULT_CONFIG,
		chatLineWidth: 999,
		fileLineWidth: 160,
		fileLineWidthBounded: false,
	};
	Reflect.set(config, "chatLineWidthBounded", "yes");
	useAppStore.getState().applyConfig(config);
	expect(useAppStore.getState()).toMatchObject({
		chatLineWidth: 120,
		fileLineWidth: 160,
		chatLineWidthBounded: true,
		fileLineWidthBounded: false,
	});
});

test("applyConfig projects the host-wide subagent default", () => {
	useAppStore.getState().applyConfig({
		...DEFAULT_CONFIG,
		subagentsEnabled: false,
	});
	expect(useAppStore.getState()).toHaveProperty("subagentsEnabled", false);
	useAppStore.getState().applyConfig({
		...DEFAULT_CONFIG,
		subagentsEnabled: true,
	});
	expect(useAppStore.getState()).toHaveProperty("subagentsEnabled", true);
});

test("applyConfig projects the per-chat subagent limit and rejects a malformed one", () => {
	useAppStore.getState().applyConfig({ ...DEFAULT_CONFIG, subagentMaxConcurrent: 9 });
	expect(useAppStore.getState()).toHaveProperty("subagentMaxConcurrent", 9);
	useAppStore.getState().applyConfig({ ...DEFAULT_CONFIG, subagentMaxConcurrent: 99 });
	expect(useAppStore.getState()).toHaveProperty("subagentMaxConcurrent", 4);
});

test("applyConfig projects disabled extensions and an older host's missing list as none", () => {
	useAppStore.getState().applyConfig({ ...DEFAULT_CONFIG, disabledExtensions: ["visualize"] });
	expect(useAppStore.getState().disabledExtensions).toEqual(["visualize"]);
	const { disabledExtensions: _omitted, ...olderHost } = DEFAULT_CONFIG;
	useAppStore.getState().applyConfig(olderHost as typeof DEFAULT_CONFIG);
	expect(useAppStore.getState().disabledExtensions).toEqual([]);
});

test("applyConfig projects JetBrains quota display and cadence", () => {
	expect(useAppStore.getState()).toMatchObject({
		jbcentralQuotaEnabled: true,
		jbcentralQuotaRefreshSeconds: 30,
	});
	useAppStore.getState().applyConfig({
		...DEFAULT_CONFIG,
		jbcentralQuotaEnabled: false,
		jbcentralQuotaRefreshSeconds: 1,
	});
	expect(useAppStore.getState()).toMatchObject({
		jbcentralQuotaEnabled: false,
		jbcentralQuotaRefreshSeconds: 1,
	});
});

test("chat presentation preferences are client-local and cannot be overwritten by host config", () => {
	useAppStore.getState().setChatMessageOrder("newest-first");
	useAppStore.getState().setStreamingResponseMovement({ settle: 60, trigger: 90 });
	const legacyConfig = {
		...DEFAULT_CONFIG,
		chatMessageOrder: "oldest-first",
		streamingResponseMovement: { settle: 75, trigger: 100 },
	};
	useAppStore.getState().applyConfig(legacyConfig);
	expect(useAppStore.getState().chatMessageOrder).toBe("newest-first");
	expect(useAppStore.getState().streamingResponseMovement).toEqual({ settle: 60, trigger: 90 });
});

test("changes tabs: one per scope, preview-eligible, and review progress survives a re-open", () => {
	const s = () => useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws1") });
	expect(s().changesView).toBe("tree");
	expect(s().changesLayout).toBe("stacked");
	const tab = {
		kind: "changes" as const,
		id: "ws1:changes:branch",
		workspaceId: testWorkspaceId("ws1"),
		name: "Changes",
		scope: { kind: "branch" } as const,
		viewed: [],
		activePath: null,
		collapsed: {},
		reveal: null,
		sections: {},
		kept: {},
	};
	s().openTab(tab, "preview");
	expect(s().previewTabByWorkspace.ws1).toBe(tab.id);
	expect(s().activeTabByWorkspace.ws1).toBe(tab.id);

	s().setChangesTabViewed(testWorkspaceId("ws1"), tab.id, "src/a.ts", true);
	// the first piece of review progress keeps the tab: a later single-click preview must not evict it
	expect(s().previewTabByWorkspace.ws1).toBeUndefined();
	expect(s().layoutIntents.at(-1)).toMatchObject({
		kind: "select",
		tabId: tab.id,
		keep: true,
		focus: false,
	});
	s().setChangesTabViewed(testWorkspaceId("ws1"), tab.id, "src/a.ts", true);
	s().setChangesTabViewed(testWorkspaceId("ws1"), tab.id, "src/b.ts", true);
	s().setChangesTabViewed(testWorkspaceId("ws1"), tab.id, "src/b.ts", false);
	s().setChangesTabActivePath(testWorkspaceId("ws1"), tab.id, "src/a.ts");
	s().setChangesTabCollapsed(testWorkspaceId("ws1"), tab.id, {
		"bun.lock": false,
		"src/a.ts": true,
	});
	s().setChangesTabCollapsed(testWorkspaceId("ws1"), tab.id, { "src/a.ts": null });
	s().requestChangesTabReveal(testWorkspaceId("ws1"), tab.id, "src/b.ts");
	s().requestChangesTabReveal(testWorkspaceId("ws1"), tab.id, "src/b.ts");
	s().setChangesTabSectionRenderer(
		testWorkspaceId("ws1"),
		tab.id,
		"README.md",
		"thinkrail/markdown",
	);
	s().setChangesTabSectionViewState(testWorkspaceId("ws1"), tab.id, "README.md", { scrollTop: 7 });
	s().setChangesTabView(testWorkspaceId("ws1"), tab.id, "inline");
	s().setChangesTabIgnoreWhitespace(testWorkspaceId("ws1"), tab.id, true);
	s().setChangesTabHunkKept(testWorkspaceId("ws1"), tab.id, "src/a.ts", "h1", true, ["h1", "h2"]);
	s().setChangesTabHunkKept(testWorkspaceId("ws1"), tab.id, "src/a.ts", "h2", true, ["h1", "h2"]);
	s().setChangesTabHunkKept(testWorkspaceId("ws1"), tab.id, "src/a.ts", "h1", false, ["h1", "h2"]);
	s().setChangesTabHunkKept(testWorkspaceId("ws1"), tab.id, "src/a.ts", "h1", false, ["h1", "h2"]);

	const after = s().tabsByWorkspace.ws1?.[0];
	if (after?.kind !== "changes") throw new Error("expected a changes tab");
	expect(after.viewed).toEqual(["src/a.ts"]);
	expect(after.activePath).toBe("src/a.ts");
	expect(after.collapsed).toEqual({ "bun.lock": false });
	expect(after.reveal).toEqual({ path: "src/b.ts", tick: 2 });
	expect(after.sections["README.md"]).toEqual({
		rendererId: "thinkrail/markdown",
		viewState: { scrollTop: 7 },
	});
	// a renderer switch drops the view state saved for the previous renderer, like setTabRenderer
	s().setChangesTabSectionRenderer(testWorkspaceId("ws1"), tab.id, "README.md", "thinkrail/code");
	const switched = s().tabsByWorkspace.ws1?.[0];
	expect(switched?.kind === "changes" && switched.sections["README.md"]).toEqual({
		rendererId: "thinkrail/code",
	});
	expect(after.view).toBe("inline");
	expect(after.ignoreWhitespace).toBe(true);
	expect(after.kept).toEqual({ "src/a.ts": ["h2"] });

	s().consumeChangesTabReveal(testWorkspaceId("ws1"), tab.id, null);
	const cleared = s().tabsByWorkspace.ws1?.[0];
	expect(cleared?.kind === "changes" && cleared.reveal).toBeNull();

	s().openTab(cleared as typeof tab, "keep");
	expect(s().tabsByWorkspace.ws1).toHaveLength(1);
	expect(s().previewTabByWorkspace.ws1).toBeUndefined();
	const kept = s().tabsByWorkspace.ws1?.[0];
	expect(kept?.kind === "changes" && kept.viewed).toEqual(["src/a.ts"]);

	// a different scope is a different tab
	s().openTab({ ...tab, id: "ws1:changes:uncommitted", scope: { kind: "uncommitted" } }, "preview");
	expect(s().tabsByWorkspace.ws1).toHaveLength(2);
	// actions against a foreign workspace or an unknown id are no-ops
	const before = s().tabsByWorkspace;
	s().setChangesTabViewed(testWorkspaceId("ws2"), tab.id, "x", true);
	s().setChangesTabActivePath(testWorkspaceId("ws1"), "missing", "x");
	expect(s().tabsByWorkspace).toBe(before);
});

test("consuming a changes-tab reveal lands active path, expansion and focus in one write", () => {
	const s = () => useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws1") });
	const tab = {
		kind: "changes" as const,
		id: "ws1:changes:branch",
		workspaceId: testWorkspaceId("ws1"),
		name: "Changes",
		scope: { kind: "branch" } as const,
		viewed: [],
		activePath: null,
		collapsed: { "src/a.ts": true },
		reveal: null,
		sections: {},
		kept: {},
	};
	s().openTab(tab, "keep");
	s().requestChangesTabReveal(testWorkspaceId("ws1"), tab.id, "src/a.ts", "c1");
	let writes = 0;
	const unsubscribe = useAppStore.subscribe(() => {
		writes += 1;
	});
	s().consumeChangesTabReveal(testWorkspaceId("ws1"), tab.id, {
		path: "src/a.ts",
		commentId: "c1",
	});
	unsubscribe();
	expect(writes).toBe(1);
	const after = s().tabsByWorkspace.ws1?.[0];
	expect(after).toMatchObject({
		activePath: "src/a.ts",
		collapsed: { "src/a.ts": false },
		reveal: null,
	});
	expect(s().reviewFocusRequest).toEqual({
		workspaceId: testWorkspaceId("ws1"),
		commentId: "c1",
		surface: { kind: "diff", scope: { kind: "branch" } },
	});

	s().setChangesTabSectionViewState(testWorkspaceId("ws1"), tab.id, "src/a.ts", { scrollTop: 3 });
	const saved = s().tabsByWorkspace;
	s().setChangesTabSectionViewState(testWorkspaceId("ws1"), tab.id, "src/a.ts", { scrollTop: 3 });
	expect(s().tabsByWorkspace).toBe(saved);
});

test("diff tabs: openTab dedupes by id + activates; renderer, view state, and contents update in place", () => {
	const s = () => useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws1") });
	const tab = {
		kind: "diff" as const,
		id: "ws1:diff:branch:src/a.ts",
		workspaceId: testWorkspaceId("ws1"),
		name: "a.ts",
		path: "src/a.ts",
		scope: { kind: "branch" } as const,
		original: "old",
		modified: "new",
		loadedTick: 1,
		loadedTarget: "main",
	};
	s().openTab(tab, "keep");
	s().openTab(tab, "keep");
	expect(s().tabsByWorkspace.ws1).toHaveLength(1);
	expect(s().activeTabByWorkspace.ws1).toBe(tab.id);

	s().setDiffTabView(tab.id, "inline");
	s().setTabViewState(testWorkspaceId("ws1"), tab.id, { scrollTop: 1 });
	s().setTabRenderer(testWorkspaceId("ws1"), tab.id, "thinkrail/code");
	expect(s().tabsByWorkspace.ws1?.[0]).not.toHaveProperty("viewState");
	s().setTabViewState(testWorkspaceId("ws1"), tab.id, { scrollTop: 42 });
	const afterView = s().tabsByWorkspace.ws1?.[0];
	expect(afterView?.kind === "diff" && afterView.view).toBe("inline");
	expect(afterView?.kind === "diff" && afterView.rendererId).toBe("thinkrail/code");
	expect(afterView?.kind === "diff" && afterView.viewState).toEqual({ scrollTop: 42 });

	s().setDiffTabIgnoreWhitespace(tab.id, true);
	const afterWs = s().tabsByWorkspace.ws1?.[0];
	expect(afterWs?.kind === "diff" && !isFileComparison(afterWs) && afterWs.ignoreWhitespace).toBe(
		true,
	);

	const meta = {
		original: { hash: "old-hash", byteLength: 4, text: true },
		modified: { hash: "new-hash", byteLength: 4, text: true },
	};
	s().updateDiffTabContent(
		testWorkspaceId("ws1"),
		tab.id,
		"old2",
		"new2",
		meta,
		"original-oid",
		5,
		"origin/release",
	);
	const updated = s().tabsByWorkspace.ws1?.[0];
	expect(updated?.kind).toBe("diff");
	if (updated?.kind === "diff" && !isFileComparison(updated)) {
		expect(updated.original).toBe("old2");
		expect(updated.modified).toBe("new2");
		expect(updated.meta).toEqual(meta);
		expect(updated.originalOid).toBe("original-oid");
		expect(updated.loadedTick).toBe(5);
		expect(updated.loadedTarget).toBe("origin/release");
	}
});

test("live content updates are scoped when two workspaces reuse an opaque cache id", () => {
	useAppStore.setState({
		tabsByWorkspace: {
			ws1: [
				{
					kind: "file",
					id: "legacy-placement",
					workspaceId: testWorkspaceId("ws1"),
					name: "one",
					path: "one",
					content: "one",
				},
			],
			ws2: [
				{
					kind: "file",
					id: "legacy-placement",
					workspaceId: testWorkspaceId("ws2"),
					name: "two",
					path: "two",
					content: "two",
				},
			],
		},
	});
	useAppStore
		.getState()
		.updateFileTabContent(testWorkspaceId("ws2"), "legacy-placement", "fresh", undefined, 4);
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws2") });
	useAppStore
		.getState()
		.setTabRenderer(testWorkspaceId("ws2"), "legacy-placement", "thinkrail/code");
	useAppStore
		.getState()
		.setTabViewState(testWorkspaceId("ws2"), "legacy-placement", { scrollTop: 7 });
	const untouched = useAppStore.getState().tabsByWorkspace.ws1?.[0];
	expect(untouched?.kind === "file" && untouched.content).toBe("one");
	const updated = useAppStore.getState().tabsByWorkspace.ws2?.[0];
	expect(updated?.kind === "file" && updated.content).toBe("fresh");
	expect(updated?.kind === "file" && updated.rendererId).toBe("thinkrail/code");
	expect(updated?.kind === "file" && updated.viewState).toEqual({ scrollTop: 7 });
});

test("resource renderer state persists to its owning workspace after the active workspace switches", () => {
	const fileTab = (workspaceId: WorkspaceId, content: string): FileTab => ({
		kind: "file",
		id: "shared-placement",
		workspaceId,
		name: `${workspaceId}.txt`,
		path: `${workspaceId}.txt`,
		content,
	});
	useAppStore.setState({
		activeWorkspaceId: testWorkspaceId("ws1"),
		tabsByWorkspace: {
			ws1: [fileTab(testWorkspaceId("ws1"), "one")],
			ws2: [fileTab(testWorkspaceId("ws2"), "two")],
		},
	});
	const { setTabRenderer, setTabViewState } = useAppStore.getState();

	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws2") });
	setTabRenderer(testWorkspaceId("ws1"), "shared-placement", "thinkrail/code");
	setTabViewState(testWorkspaceId("ws1"), "shared-placement", { scrollTop: 37 });

	expect(useAppStore.getState().tabsByWorkspace.ws1?.[0]).toMatchObject({
		rendererId: "thinkrail/code",
		viewState: { scrollTop: 37 },
	});
	expect(useAppStore.getState().tabsByWorkspace.ws2?.[0]).not.toHaveProperty("rendererId");
	expect(useAppStore.getState().tabsByWorkspace.ws2?.[0]).not.toHaveProperty("viewState");
});

test("the diff scope is per workspace, defaults to the branch, and is dropped with the workspace", () => {
	const s = () => useAppStore.getState();
	useAppStore.setState({
		workspaces: {
			p1: [
				{
					id: testWorkspaceId("ws1"),
					projectId: testProjectId("p1"),
					name: "ws1",
					branch: "b",
					worktreePath: "/wt",
					baseBranch: "main",
				},
			],
		},
		activeWorkspaceId: testWorkspaceId("ws1"),
		selectedProjectId: testProjectId("p1"),
	});
	expect(selectDiffScope(s(), testWorkspaceId("ws1"))).toBe(
		selectDiffScope(s(), testWorkspaceId("ws2")),
	);
	expect(selectDiffScope(s(), testWorkspaceId("ws1"))).toEqual({ kind: "branch" });

	s().setDiffScope(testWorkspaceId("ws1"), { kind: "commit", sha: "abc123" });
	expect(selectDiffScope(s(), testWorkspaceId("ws1"))).toEqual({ kind: "commit", sha: "abc123" });
	expect(selectDiffScope(s(), testWorkspaceId("ws2"))).toEqual({ kind: "branch" });

	s().applyWorkspaceRemoved(testProjectId("p1"), testWorkspaceId("ws1"));
	expect(s().diffScopeByWorkspace.ws1).toBeUndefined();
});

const skillFs = (
	workspaceId: WorkspaceId,
	paths: string[],
	skillChange: WorkspaceSkillChange = "detected",
	truncated = false,
): WorkspaceFsChangedPayload => ({ workspaceId, paths, truncated, skillChange });
const isStale = (workspaceId: WorkspaceId, sessionId: SessionId) =>
	selectSkillsStale(useAppStore.getState(), workspaceId, sessionId);

test("skills badge: a skill-dir change flags the loaded session; reload clears it for good", () => {
	const s = () => useAppStore.getState();
	s().openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	expect(isStale(testWorkspaceId("ws1"), testSessionId("a"))).toBe(false);

	s().noteFsChanged(skillFs(testWorkspaceId("ws1"), [".claude/skills/foo/SKILL.md"]));
	expect(isStale(testWorkspaceId("ws1"), testSessionId("a"))).toBe(true);

	expect(isStale(testWorkspaceId("ws1"), testSessionId("a"))).toBe(true);

	s().markSkillsSynced(testSessionId("a"), selectWorkspaceTick(s(), testWorkspaceId("ws1")));
	expect(isStale(testWorkspaceId("ws1"), testSessionId("a"))).toBe(false);

	s().noteFsChanged(skillFs(testWorkspaceId("ws1"), ["src/app.ts"], "none"));
	s().noteFsChanged(skillFs(testWorkspaceId("ws1"), ["README.md"], "none"));
	expect(isStale(testWorkspaceId("ws1"), testSessionId("a"))).toBe(false);
});

test("skills badge: the skill-change tick is accumulated, so a later non-skill batch can't lose it", () => {
	const s = () => useAppStore.getState();
	s().openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	s().noteFsChanged(skillFs(testWorkspaceId("ws1"), [".claude/skills/foo/SKILL.md"]));
	s().noteFsChanged(skillFs(testWorkspaceId("ws1"), ["src/app.ts"], "none"));
	expect(isStale(testWorkspaceId("ws1"), testSessionId("a"))).toBe(true);
});

test("skills badge: a pathless skill-neutral repo-metadata nudge refreshes without staling", () => {
	const s = () => useAppStore.getState();
	s().openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	s().noteFsChanged(skillFs(testWorkspaceId("ws1"), [], "none"));
	expect(selectWorkspaceTick(s(), testWorkspaceId("ws1"))).toBe(1);
	expect(isStale(testWorkspaceId("ws1"), testSessionId("a"))).toBe(false);
});

test("skills badge: generic path overflow is neutral, but detected and unknown skill impact flags", () => {
	const s = () => useAppStore.getState();
	s().openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	s().noteFsChanged(skillFs(testWorkspaceId("ws1"), ["dist/chunk.js"], "none", true));
	expect(selectWorkspaceTick(s(), testWorkspaceId("ws1"))).toBe(1);
	expect(isStale(testWorkspaceId("ws1"), testSessionId("a"))).toBe(false);

	s().noteFsChanged(skillFs(testWorkspaceId("ws1"), ["dist/chunk.js"], "detected", true));
	expect(isStale(testWorkspaceId("ws1"), testSessionId("a"))).toBe(true);
	s().markSkillsSynced(testSessionId("a"), selectWorkspaceTick(s(), testWorkspaceId("ws1")));

	s().noteFsChanged(skillFs(testWorkspaceId("ws1"), [], "unknown", true));
	expect(isStale(testWorkspaceId("ws1"), testSessionId("a"))).toBe(true);
});

test("skills badge: non-skill overflow during session creation does not open the new chat stale", () => {
	const s = () => useAppStore.getState();
	s().noteFsChanged(skillFs(testWorkspaceId("ws1"), [], "unknown", true));
	const baseline = selectWorkspaceTick(s(), testWorkspaceId("ws1"));
	s().noteFsChanged(skillFs(testWorkspaceId("ws1"), ["dist/chunk.js"], "none", true));
	s().openChatSession(testWorkspaceId("ws1"), testSessionId("new"), null, "medium", baseline);
	expect(isStale(testWorkspaceId("ws1"), testSessionId("new"))).toBe(false);
});

test("skills badge: per session — a chat opened after the change isn't flagged; reload clears only its own", () => {
	const s = () => useAppStore.getState();
	s().openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	s().noteFsChanged(skillFs(testWorkspaceId("ws1"), [".claude/skills/foo/SKILL.md"]));
	s().openChatSession(testWorkspaceId("ws1"), testSessionId("b"), null, "medium");
	expect(isStale(testWorkspaceId("ws1"), testSessionId("a"))).toBe(true);
	expect(isStale(testWorkspaceId("ws1"), testSessionId("b"))).toBe(false);

	s().noteFsChanged(skillFs(testWorkspaceId("ws1"), [".claude/skills/foo/SKILL.md"]));
	expect(isStale(testWorkspaceId("ws1"), testSessionId("a"))).toBe(true);
	expect(isStale(testWorkspaceId("ws1"), testSessionId("b"))).toBe(true);

	s().markSkillsSynced(testSessionId("b"), selectWorkspaceTick(s(), testWorkspaceId("ws1")));
	expect(isStale(testWorkspaceId("ws1"), testSessionId("a"))).toBe(true);
	expect(isStale(testWorkspaceId("ws1"), testSessionId("b"))).toBe(false);
});

test("skills badge: a skill change mid-reload stays flagged (baseline is captured at reload start)", () => {
	const s = () => useAppStore.getState();
	s().openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	const reloadBaseline = selectWorkspaceTick(s(), testWorkspaceId("ws1"));
	s().noteFsChanged(skillFs(testWorkspaceId("ws1"), [".claude/skills/foo/SKILL.md"]));
	s().markSkillsSynced(testSessionId("a"), reloadBaseline);
	expect(isStale(testWorkspaceId("ws1"), testSessionId("a"))).toBe(true);
});

test("skills badge: closing a chat runtime drops its sync baseline (no leak)", () => {
	const s = () => useAppStore.getState();
	s().openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");
	s().noteFsChanged(skillFs(testWorkspaceId("ws1"), [".claude/skills/foo/SKILL.md"]));
	s().markSkillsSynced(testSessionId("a"), selectWorkspaceTick(s(), testWorkspaceId("ws1")));
	expect(s().skillsSyncedTickBySession.a).toBeDefined();

	s().closeChatRuntime(testSessionId("a"));
	expect(s().skillsSyncedTickBySession.a).toBeUndefined();
});

test("skills badge: markSkillsSynced is monotonic and ignores a disposed session", () => {
	const s = () => useAppStore.getState();
	s().openChatSession(testWorkspaceId("ws1"), testSessionId("a"), null, "medium");

	s().markSkillsSynced(testSessionId("a"), 5);
	s().markSkillsSynced(testSessionId("a"), 2);
	expect(s().skillsSyncedTickBySession.a).toBe(5);

	s().closeChatRuntime(testSessionId("a"));
	s().markSkillsSynced(testSessionId("a"), 9);
	expect(s().skillsSyncedTickBySession.a).toBeUndefined();
});

const summaryFor = (sessionId: SessionId, live: boolean): SessionSummary => ({
	sessionId,
	workspaceId: testWorkspaceId("ws1"),
	title: "Chat",
	model: null,
	thinkingLevel: "medium",
	isStreaming: false,
	messageCount: 0,
	updatedAt: 0,
	live,
});

test("skills badge: a LIVE restore stays conservatively stale; a disk attach anchors to its load tick", () => {
	const s = () => useAppStore.getState();
	s().noteFsChanged(skillFs(testWorkspaceId("ws1"), [".claude/skills/foo/SKILL.md"]));

	s().hydrateSession(summaryFor(testSessionId("live1"), true), emptyHydration());
	expect(isStale(testWorkspaceId("ws1"), testSessionId("live1"))).toBe(true);

	s().hydrateSession(
		summaryFor(testSessionId("disk1"), false),
		emptyHydration(),
		false,
		selectWorkspaceTick(s(), testWorkspaceId("ws1")),
	);
	expect(isStale(testWorkspaceId("ws1"), testSessionId("disk1"))).toBe(false);
});

test("explicitly passive hydration never becomes navigation just because the cache has no active tab", () => {
	const store = useAppStore.getState();
	store.hydrateSession(
		summaryFor(testSessionId("passive"), true),
		emptyHydration(),
		false,
		undefined,
		{
			activate: false,
		},
	);
	expect(useAppStore.getState().activeTabByWorkspace.ws1).toBeUndefined();
	expect(useAppStore.getState().navTickByWorkspace.ws1).toBeUndefined();
});

function fileTab(workspaceId: WorkspaceId, name: string): FileTab {
	return { kind: "file", id: `${workspaceId}:${name}`, workspaceId, name, path: name, content: "" };
}

test("a preview open replaces the previous preview tab at its index (the strip never reshuffles)", () => {
	const store = useAppStore.getState();
	store.openTab(fileTab(testWorkspaceId("ws1"), "a.ts"), "keep");
	store.openTab(fileTab(testWorkspaceId("ws1"), "b.ts"), "preview");
	store.openTab(fileTab(testWorkspaceId("ws1"), "c.ts"), "keep");

	store.openTab(fileTab(testWorkspaceId("ws1"), "d.ts"), "preview");

	const s = useAppStore.getState();
	expect((s.tabsByWorkspace.ws1 ?? []).map((t) => t.name)).toEqual(["a.ts", "d.ts", "c.ts"]);
	expect(s.previewTabByWorkspace.ws1).toBe("ws1:d.ts");
	expect(s.activeTabByWorkspace.ws1).toBe("ws1:d.ts");
});

test("hydrated per-group previews never evict one another from the render cache", () => {
	const document: WorkspaceLayoutDocument = {
		version: 2,
		center: { kind: "group", id: "center-a", tabs: [] },
		left: { visible: false, width: 0.18, groups: [] },
		right: { visible: false, width: 0.28, groups: [] },
		bottom: emptyBottomRegion(),
		toolRestoreTargets: {},
	};
	useAppStore.setState({ layoutDocumentsByWorkspace: { ws1: document } });
	const store = useAppStore.getState();
	store.openTab(fileTab(testWorkspaceId("ws1"), "a.ts"), "preview");
	store.openTab(fileTab(testWorkspaceId("ws1"), "b.ts"), "preview");

	expect((useAppStore.getState().tabsByWorkspace.ws1 ?? []).map((tab) => tab.name)).toEqual([
		"a.ts",
		"b.ts",
	]);
});

test("a preview open of an already-kept tab focuses it without demoting it or moving the slot", () => {
	const store = useAppStore.getState();
	store.openTab(fileTab(testWorkspaceId("ws1"), "a.ts"), "keep");
	store.openTab(fileTab(testWorkspaceId("ws1"), "b.ts"), "preview");

	store.openTab(fileTab(testWorkspaceId("ws1"), "a.ts"), "preview");

	const s = useAppStore.getState();
	expect(s.activeTabByWorkspace.ws1).toBe("ws1:a.ts");
	expect(s.previewTabByWorkspace.ws1).toBe("ws1:b.ts");
	expect(s.tabsByWorkspace.ws1).toHaveLength(2);
});

test("keep releases the slot — through openTab, through setActiveTab, and through closeTab", () => {
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws1") });
	const store = useAppStore.getState();

	store.openTab(fileTab(testWorkspaceId("ws1"), "a.ts"), "preview");
	store.setActiveTab("ws1:a.ts", "keep");
	expect(useAppStore.getState().previewTabByWorkspace.ws1).toBeUndefined();

	store.openTab(fileTab(testWorkspaceId("ws1"), "b.ts"), "preview");
	store.openTab(fileTab(testWorkspaceId("ws1"), "b.ts"), "keep");
	expect(useAppStore.getState().previewTabByWorkspace.ws1).toBeUndefined();

	store.openTab(fileTab(testWorkspaceId("ws1"), "c.ts"), "preview");
	store.closeTab("ws1:c.ts");
	expect(useAppStore.getState().previewTabByWorkspace.ws1).toBeUndefined();
});

test("promotion is one-way: neither a plain activation nor a keep elsewhere demotes a tab", () => {
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws1") });
	const store = useAppStore.getState();
	store.openTab(fileTab(testWorkspaceId("ws1"), "a.ts"), "keep");
	store.openTab(fileTab(testWorkspaceId("ws1"), "b.ts"), "preview");

	store.setActiveTab("ws1:a.ts");
	expect(useAppStore.getState().previewTabByWorkspace.ws1).toBe("ws1:b.ts");

	store.setActiveTab("ws1:a.ts", "keep");
	expect(useAppStore.getState().previewTabByWorkspace.ws1).toBe("ws1:b.ts");
});

test("the slot is per workspace — clearWorkspaceTabs releases only its own", () => {
	const store = useAppStore.getState();
	store.openTab(fileTab(testWorkspaceId("ws1"), "a.ts"), "preview");
	store.openTab(fileTab(testWorkspaceId("ws2"), "b.ts"), "preview");

	store.clearWorkspaceTabs(testWorkspaceId("ws1"));

	const s = useAppStore.getState();
	expect(s.previewTabByWorkspace.ws1).toBeUndefined();
	expect(s.previewTabByWorkspace.ws2).toBe("ws2:b.ts");
});

test("chat, document, and plan tabs never enter the preview slot", () => {
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws1") });
	const store = useAppStore.getState();
	store.openTab(fileTab(testWorkspaceId("ws1"), "a.ts"), "preview");

	store.openChatSession(testWorkspaceId("ws1"), testSessionId("s1"), null, "medium");
	store.openDoc({
		kind: "doc",
		id: "ws1:plan",
		workspaceId: testWorkspaceId("ws1"),
		name: "Plan",
		content: "# plan",
		docPath: "plan.md",
		sourceId: "s1",
	});
	store.openTab(
		{
			kind: "chat",
			id: "direct-chat",
			workspaceId: testWorkspaceId("ws1"),
			name: "Direct chat",
			sessionId: testSessionId("s2"),
		},
		"preview",
	);
	store.openDoc({
		kind: "plan",
		id: "ws1:live-plan",
		workspaceId: testWorkspaceId("ws1"),
		name: "Live plan",
		sessionId: testSessionId("s3"),
	});

	const s = useAppStore.getState();
	expect(s.previewTabByWorkspace.ws1).toBe("ws1:a.ts");
	expect(s.tabsByWorkspace.ws1).toHaveLength(5);
	expect(s.layoutIntents.at(-1)).toMatchObject({ kind: "open", intent: "keep" });
});

test("a keep on an already-open tab releases ITS workspace's slot, never the active one's", () => {
	const store = useAppStore.getState();
	store.openTab(fileTab(testWorkspaceId("ws1"), "a.ts"), "preview");
	store.openTab(fileTab(testWorkspaceId("ws2"), "b.ts"), "preview");
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws2") });

	store.openTab(fileTab(testWorkspaceId("ws1"), "a.ts"), "keep");

	const s = useAppStore.getState();
	expect(s.previewTabByWorkspace.ws1).toBeUndefined();
	expect(s.previewTabByWorkspace.ws2).toBe("ws2:b.ts");
	expect(s.activeTabByWorkspace.ws1).toBe("ws1:a.ts");
	expect(s.activeTabByWorkspace.ws2).toBe("ws2:b.ts");
});

test("every center navigation bumps the workspace's nav tick, and none of them bypass it", () => {
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws1") });
	const tick = () => useAppStore.getState().navTickByWorkspace.ws1 ?? 0;
	const missed: string[] = [];
	const bumps = (label: string, act: () => void) => {
		const before = tick();
		act();
		if (tick() <= before) missed.push(label);
	};

	const s = () => useAppStore.getState();
	const beforeOpen = tick();
	s().openTab(fileTab(testWorkspaceId("ws1"), "a.ts"), "preview");
	s().openTab(fileTab(testWorkspaceId("ws1"), "a.ts"), "keep");
	expect(tick()).toBe(beforeOpen);

	bumps("setActiveTab", () => s().setActiveTab("ws1:a.ts"));
	bumps("openDoc", () =>
		s().openDoc({
			kind: "doc",
			id: "ws1:plan",
			workspaceId: testWorkspaceId("ws1"),
			name: "Plan",
			content: "# p",
			docPath: "plan.md",
			sourceId: "s1",
		}),
	);
	bumps("openChatSession", () =>
		s().openChatSession(testWorkspaceId("ws1"), testSessionId("sess"), null, "medium"),
	);
	bumps("closeChatToHistory", () => s().closeChatToHistory(testSessionId("sess")));
	bumps("reopenChat", () => s().reopenChat(testWorkspaceId("ws1"), testSessionId("sess")));
	s().setActiveTab("ws1:a.ts");
	bumps("closeTab", () => s().closeTab("ws1:a.ts"));
	bumps("noteNavigation", () => s().noteNavigation(testWorkspaceId("ws1")));
	bumps("requestHistoryOpen", () =>
		s().requestHistoryOpen({
			sessionId: testSessionId("sess"),
			workspaceId: testWorkspaceId("ws1"),
			tabId: "ws1:sess",
		}),
	);
	expect(s().layoutIntents.at(-1)).toMatchObject({ kind: "select", focus: false });
	expect(missed).toEqual([]);

	useAppStore.setState({ activeTabByWorkspace: { ws1: "ws1:sess" } });
	const before = tick();
	s().hydrateSession(
		{
			sessionId: testSessionId("bg"),
			workspaceId: testWorkspaceId("ws1"),
			title: "bg",
			createdAt: 0,
			updatedAt: 0,
			live: true,
		} as unknown as SessionSummary,
		emptyHydration(),
	);
	expect(tick()).toBe(before);

	expect(useAppStore.getState().navTickByWorkspace.ws2).toBeUndefined();
	s().clearWorkspaceTabs(testWorkspaceId("ws1"));
	expect(useAppStore.getState().navTickByWorkspace.ws1).toBeUndefined();
});

test("history selection resolves a cache alias to its stable shared placement id", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("history-alias"), null, "medium");
	const cache = useAppStore
		.getState()
		.tabsByWorkspace.ws1?.find((tab) => tab.kind === "chat" && tab.sessionId === "history-alias");
	if (!cache) throw new Error("missing history cache fixture");
	useAppStore.setState({
		layoutIntents: [],
		layoutDocumentsByWorkspace: {
			ws1: {
				version: 2,
				center: {
					kind: "group",
					id: "history-group",
					tabs: [
						{
							kind: "chat",
							id: "legacy-history-placement",
							name: "History",
							sessionId: testSessionId("history-alias"),
						},
					],
				},
				left: { visible: false, width: 0.2, groups: [] },
				right: { visible: false, width: 0.2, groups: [] },
				bottom: emptyBottomRegion(),
				toolRestoreTargets: {},
			},
		},
		layoutAttentionByWorkspace: {
			ws1: {
				selectedByGroup: { "history-group": "legacy-history-placement" },
				lastFocusedCenterGroupId: "history-group",
				lastFocusedSideGroupId: {},
				navigationClockByGroup: { "history-group": 0 },
			},
		},
	});
	store.requestHistoryOpen({
		workspaceId: testWorkspaceId("ws1"),
		sessionId: testSessionId("history-alias"),
		tabId: cache.id,
	});
	expect(useAppStore.getState().layoutIntents.at(-1)).toMatchObject({
		kind: "select",
		tabId: "legacy-history-placement",
		resource: { kind: "chat", sessionId: testSessionId("history-alias") },
		focus: false,
	});
});

test("history selection never uses a colliding cache id as shared placement identity", () => {
	const store = useAppStore.getState();
	store.openChatSession(testWorkspaceId("ws1"), testSessionId("history-collision"), null, "medium");
	const chat = useAppStore
		.getState()
		.tabsByWorkspace.ws1?.find(
			(tab) => tab.kind === "chat" && tab.sessionId === "history-collision",
		);
	if (!chat) throw new Error("missing colliding history cache fixture");
	const collidingId = "opaque-collision";
	useAppStore.setState({
		layoutIntents: [],
		tabsByWorkspace: { ws1: [{ ...chat, id: collidingId }] },
		layoutDocumentsByWorkspace: {
			ws1: {
				version: 2,
				center: {
					kind: "split",
					id: "history-split",
					direction: "horizontal",
					weights: [0.5, 0.5],
					children: [
						{ kind: "group", id: "history-origin", tabs: [] },
						{
							kind: "group",
							id: "history-collision-group",
							tabs: [{ kind: "file", id: collidingId, name: "other.ts", path: "other.ts" }],
						},
					],
				},
				left: { visible: false, width: 0.2, groups: [] },
				right: { visible: false, width: 0.2, groups: [] },
				bottom: emptyBottomRegion(),
				toolRestoreTargets: {},
			},
		},
		layoutAttentionByWorkspace: {
			ws1: {
				selectedByGroup: { "history-collision-group": collidingId },
				lastFocusedCenterGroupId: "history-origin",
				lastFocusedSideGroupId: {},
				navigationClockByGroup: { "history-origin": 0, "history-collision-group": 0 },
			},
		},
	});
	store.requestHistoryOpen({
		workspaceId: testWorkspaceId("ws1"),
		sessionId: testSessionId("history-collision"),
		tabId: collidingId,
	});
	const state = useAppStore.getState();
	expect(state.layoutIntents.at(-1)).toMatchObject({
		kind: "select",
		resource: { kind: "chat", sessionId: testSessionId("history-collision") },
		navigation: { groupId: "history-origin", clock: 1 },
	});
	expect(state.layoutAttentionByWorkspace.ws1?.lastFocusedCenterGroupId).toBe("history-origin");
	expect(state.layoutAttentionByWorkspace.ws1?.navigationClockByGroup["history-origin"]).toBe(1);
	expect(
		state.layoutAttentionByWorkspace.ws1?.navigationClockByGroup["history-collision-group"],
	).toBe(0);
});

test("an accepted background close removes the cache from its captured workspace", () => {
	const store = useAppStore.getState();
	store.openTab(fileTab(testWorkspaceId("ws1"), "a.ts"), "keep");
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws2") });
	store.closeTab("ws1:a.ts", false, false, testWorkspaceId("ws1"));
	expect(useAppStore.getState().tabsByWorkspace.ws1).toEqual([]);
	expect(useAppStore.getState().tabsByWorkspace.ws2).toBeUndefined();
});

test("a close that moves no focus is not a navigation — it can't discard a browse in flight", () => {
	useAppStore.setState({ activeWorkspaceId: testWorkspaceId("ws1") });
	const s = () => useAppStore.getState();
	const tick = () => s().navTickByWorkspace.ws1 ?? 0;

	s().openTab(fileTab(testWorkspaceId("ws1"), "a.ts"), "keep");
	s().openTab(fileTab(testWorkspaceId("ws1"), "b.ts"), "keep");
	s().openChatSession(testWorkspaceId("ws1"), testSessionId("sess"), null, "medium");
	s().setActiveTab("ws1:b.ts");
	const before = tick();

	s().closeTab("ws1:a.ts");
	expect(tick()).toBe(before);
	expect(s().activeTabByWorkspace.ws1).toBe("ws1:b.ts");

	s().closeChatToHistory(testSessionId("sess"));
	expect(tick()).toBe(before);
	expect(s().activeTabByWorkspace.ws1).toBe("ws1:b.ts");

	s().closeTab("ws1:b.ts");
	expect(tick()).toBeGreaterThan(before);
});

test("terminal creation can capture a center-group destination without creating a second authority", () => {
	useAppStore.setState({
		layoutAttentionByWorkspace: {
			w1: {
				selectedByGroup: {},
				lastFocusedCenterGroupId: "center-a",
				lastFocusedSideGroupId: {},
				navigationClockByGroup: { "center-a": 1, "center-b": 3 },
			},
		},
	});
	useAppStore.getState().addTerminal(testWorkspaceId("w1"), undefined, "center-b");
	const state = useAppStore.getState();
	expect(state.terminalsByWorkspace.w1).toHaveLength(1);
	expect(state.layoutIntents).toHaveLength(1);
	expect(state.layoutIntents[0]).toMatchObject({
		kind: "place-terminal",
		workspaceId: testWorkspaceId("w1"),
		targetGroupId: "center-b",
	});
	expect(state.layoutAttentionByWorkspace.w1).toMatchObject({
		lastFocusedCenterGroupId: "center-b",
		navigationClockByGroup: { "center-a": 1, "center-b": 4 },
	});
	expect(state.navTickByWorkspace.w1).toBe(1);
});

test("terminal creation can target bottom without advancing center navigation", () => {
	const attention = {
		selectedByGroup: {},
		lastFocusedCenterGroupId: "center-a",
		lastFocusedSideGroupId: { bottom: "bottom-a" },
		navigationClockByGroup: { "center-a": 2 },
	};
	useAppStore.setState({ layoutAttentionByWorkspace: { w1: attention } });
	useAppStore.getState().addTerminal(testWorkspaceId("w1"), undefined, "bottom-b", "bottom");
	const state = useAppStore.getState();
	expect(state.layoutIntents[0]).toMatchObject({
		kind: "place-terminal",
		workspaceId: testWorkspaceId("w1"),
		targetGroupId: "bottom-b",
		targetArea: "bottom",
	});
	expect(state.layoutAttentionByWorkspace.w1).toBe(attention);
	expect(state.navTickByWorkspace.w1).toBeUndefined();
});

test("the host catalog confirms a reservation while retaining its one-shot command", () => {
	useAppStore.getState().addTerminal(testWorkspaceId("w1"), "code .", "bottom-a", "bottom");
	const pending = useAppStore.getState().terminalsByWorkspace.w1?.[0];
	if (!pending) throw new Error("missing pending terminal");
	expect(pending.reservationPending).toBe(true);

	useAppStore
		.getState()
		.setWorkspaceTerminals(testWorkspaceId("w1"), [
			{ tabKey: pending.tabKey, title: "Host title" },
		]);
	expect(useAppStore.getState().terminalsByWorkspace.w1).toEqual([
		{
			tabKey: pending.tabKey,
			workspaceId: testWorkspaceId("w1"),
			title: "Host title",
			initialCommand: "code .",
		},
	]);
	expect(useAppStore.getState().layoutIntents).toHaveLength(1);
});

test("hidden terminal seeding stays non-activating, idempotent, and atomically rejectable", () => {
	useAppStore
		.getState()
		.addTerminal(testWorkspaceId("w1"), undefined, "bottom-a", "bottom", false, "initial-terminal");
	useAppStore
		.getState()
		.addTerminal(testWorkspaceId("w1"), undefined, "bottom-a", "bottom", false, "initial-terminal");
	const pending = useAppStore.getState().terminalsByWorkspace.w1?.[0];
	if (!pending) throw new Error("missing pending terminal");
	expect(useAppStore.getState().terminalsByWorkspace.w1).toHaveLength(1);
	expect(useAppStore.getState().layoutIntents).toHaveLength(1);
	expect(useAppStore.getState().layoutIntents[0]).toMatchObject({
		kind: "place-terminal",
		workspaceId: testWorkspaceId("w1"),
		tabKey: pending.tabKey,
		targetGroupId: "bottom-a",
		targetArea: "bottom",
		reveal: false,
	});

	useAppStore.getState().rejectTerminalReservation(testWorkspaceId("w1"), pending.tabKey);
	expect(useAppStore.getState().terminalsByWorkspace.w1).toEqual([]);
	expect(useAppStore.getState().layoutIntents).toEqual([]);
});

test("catalog authority falls with the list it describes — only an awaited refresh sets it", () => {
	const s = () => useAppStore.getState();
	const listed = [{ id: "opus-5", name: "opus-5", provider: "anthropic" }] as WireModel[];
	const refreshed = [{ id: "opus-6", name: "opus-6", provider: "anthropic" }] as WireModel[];

	s().setModelsForProviderVersion(s().providerVersion, listed);
	expect(s().modelsFresh).toBe(false);

	const settledVersion = s().beginModelsRefresh();
	s().finishModelsRefresh(settledVersion, { models: refreshed, complete: true });
	expect(s().models).toBe(refreshed);
	expect(s().modelsRefreshing).toBe(false);
	expect(s().modelsFresh).toBe(true);

	s().setModelsForProviderVersion(s().providerVersion, listed);
	expect(s().models).toBe(listed);
	expect(s().modelsFresh).toBe(false);

	s().finishModelsRefresh(s().providerVersion, { models: refreshed, complete: true });
	const failedVersion = s().beginModelsRefresh();
	s().finishModelsRefresh(failedVersion, null);
	expect(s().models).toBe(refreshed);
	expect(s().modelsFresh).toBe(true);
});

test("a provider invalidation rejects every stale model reply", () => {
	const s = () => useAppStore.getState();
	const listed = [
		{ id: "central-model", name: "central-model", provider: "central" },
	] as WireModel[];
	const before = s().beginModelsRefresh();
	s().finishModelsRefresh(before, { models: listed, complete: true });

	s().noteProviderChanged();
	expect(s().providerVersion).toBe(before + 1);
	expect(s().models).toEqual([]);
	expect(s().modelsFresh).toBe(false);
	expect(s().modelsRefreshing).toBe(false);

	s().setModelsForProviderVersion(before, listed);
	s().finishModelsRefresh(before, { models: listed, complete: true });
	expect(s().models).toEqual([]);
	expect(s().modelsFresh).toBe(false);
});

test("a refresh whose wait was capped installs its list but claims no authority", () => {
	const s = () => useAppStore.getState();
	const listed = [{ id: "opus-5", name: "opus-5", provider: "anthropic" }] as WireModel[];
	const unsettled = [{ id: "opus-6", name: "opus-6", provider: "anthropic" }] as WireModel[];
	const settledVersion = s().beginModelsRefresh();
	s().finishModelsRefresh(settledVersion, { models: listed, complete: true });
	expect(s().modelsFresh).toBe(true);

	const unsettledVersion = s().beginModelsRefresh();
	s().finishModelsRefresh(unsettledVersion, { models: unsettled, complete: false });
	expect(s().models).toBe(unsettled);
	expect(s().modelsRefreshing).toBe(false);
	expect(s().modelsFresh).toBe(false);
});

test("authority can be given up without replacing the list (a consumer activating)", () => {
	const s = () => useAppStore.getState();
	const refreshed = [{ id: "opus-6", name: "opus-6", provider: "anthropic" }] as WireModel[];
	const providerVersion = s().beginModelsRefresh();
	s().finishModelsRefresh(providerVersion, { models: refreshed, complete: true });
	expect(s().modelsFresh).toBe(true);

	s().dropModelsFreshness();
	expect(s().modelsFresh).toBe(false);
	expect(s().models).toBe(refreshed);
});

test("openSearch starts a fresh palette session even when the palette is already open", () => {
	useAppStore.setState({ searchOpen: false, searchSession: 0 });
	useAppStore.getState().openSearch();
	expect(useAppStore.getState()).toMatchObject({ searchOpen: true, searchSession: 1 });
	useAppStore.getState().openSearch();
	expect(useAppStore.getState()).toMatchObject({ searchOpen: true, searchSession: 2 });
	useAppStore.getState().closeSearch();
	useAppStore.getState().closeSearch();
	expect(useAppStore.getState()).toMatchObject({ searchOpen: false, searchSession: 2 });
});
