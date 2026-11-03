import { beforeEach, expect, test } from "bun:test";
import type { SessionId, WorkspaceId } from "@thinkrail/contracts";
import {
	type AppConfig,
	asProjectId,
	asSessionId,
	asWorkspaceId,
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
	expect(selectLastOpenChatSession(useAppStore.getState(), asWorkspaceId("ws1"))).toBeNull();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("s1"), null, "medium");
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("s2"), null, "medium");
	expect(selectLastOpenChatSession(useAppStore.getState(), asWorkspaceId("ws1"))).toBe(
		asSessionId("s2"),
	);
	useAppStore.getState().openTab(fileTab(asWorkspaceId("ws1"), "a.ts"), "keep");
	expect(selectLastOpenChatSession(useAppStore.getState(), asWorkspaceId("ws1"))).toBe(
		asSessionId("s2"),
	);
});

test("pi events route to the right session runtime; chats stay independent", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("b"), null, "high");

	store.handlePiEvent(agentStart, asSessionId("a"));
	store.handlePiEvent(toolStart("t1"), asSessionId("a"));
	expect(rt(asSessionId("a")).isStreaming).toBe(true);
	expect(rt(asSessionId("a")).toolResults.t1?.status).toBe("running");
	expect(rt(asSessionId("b")).isStreaming).toBe(false);
	expect(Object.keys(rt(asSessionId("b")).toolResults)).toHaveLength(0);

	store.handlePiEvent(agentStart, asSessionId("b"));
	expect(rt(asSessionId("a")).isStreaming).toBe(true);
	expect(rt(asSessionId("b")).isStreaming).toBe(true);

	store.handlePiEvent(agentEnd, asSessionId("a"));
	expect(rt(asSessionId("a")).isStreaming).toBe(true);
	expect(rt(asSessionId("a")).turns.some((t) => t.kind === "system" && t.text === undefined)).toBe(
		false,
	);
	store.handlePiEvent(agentSettled(), asSessionId("a"));
	expect(rt(asSessionId("a")).isStreaming).toBe(false);
	expect(rt(asSessionId("a")).turns.some((t) => t.kind === "system" && t.text === undefined)).toBe(
		true,
	);
	expect(rt(asSessionId("b")).isStreaming).toBe(true);
	expect(rt(asSessionId("b")).turns).toHaveLength(0);
});

test("an ordered Pi-event batch commits once while preserving every session revision", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("b"), null, "high");
	const partial = { content: [{ type: "text", text: "partial" }] };
	const payloads: SessionEventPayload[] = [
		{ sessionId: asSessionId("a"), event: agentStart },
		{ sessionId: asSessionId("a"), event: toolStart("t1") },
		{ sessionId: asSessionId("b"), event: agentStart },
		{ sessionId: asSessionId("a"), event: toolUpdate("t1", partial) },
		{ sessionId: asSessionId("a"), event: agentEnd },
		{ sessionId: asSessionId("missing"), event: agentStart },
	];
	let commits = 0;
	const unsubscribe = useAppStore.subscribe(() => {
		commits += 1;
	});

	store.handlePiEvents(payloads);
	unsubscribe();

	expect(commits).toBe(1);
	expect(rt(asSessionId("a")).eventRevision).toBe(4);
	expect(rt(asSessionId("a")).isStreaming).toBe(true);
	expect(rt(asSessionId("a")).toolResults.t1).toEqual({ status: "running", raw: partial });
	expect(rt(asSessionId("b")).eventRevision).toBe(1);
	expect(rt(asSessionId("b")).isStreaming).toBe(true);
});

test("a settlement tick survives a batched false-to-false streaming endpoint", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	expect(rt(asSessionId("a")).settlementTick).toBe(0);
	let commits = 0;
	const unsubscribe = useAppStore.subscribe(() => {
		commits += 1;
	});

	store.handlePiEvents([
		{ sessionId: asSessionId("a"), event: agentStart },
		{ sessionId: asSessionId("a"), event: agentEnd },
		{ sessionId: asSessionId("a"), event: agentSettled() },
	]);
	unsubscribe();

	expect(commits).toBe(1);
	expect(rt(asSessionId("a")).isStreaming).toBe(false);
	expect(rt(asSessionId("a")).settlementTick).toBe(1);
	store.handlePiEvent(agentEnd, asSessionId("a"));
	expect(rt(asSessionId("a")).settlementTick).toBe(1);
	store.handlePiEvent(agentSettled(), asSessionId("a"));
	expect(rt(asSessionId("a")).settlementTick).toBe(2);
});

test("stats refresh ticks survive batching at finalized Pi state boundaries", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	let commits = 0;
	const unsubscribe = useAppStore.subscribe(() => {
		commits += 1;
	});

	store.handlePiEvents([
		{ sessionId: asSessionId("a"), event: agentStart },
		{ sessionId: asSessionId("a"), event: assistantStart },
		{ sessionId: asSessionId("a"), event: assistantText("streaming") },
		{
			sessionId: asSessionId("a"),
			event: {
				type: "message_end",
				message: { role: "toolResult" },
			} as unknown as PiEvent,
		},
		{ sessionId: asSessionId("a"), event: { type: "compaction_start", reason: "manual" } },
		{
			sessionId: asSessionId("a"),
			event: {
				type: "compaction_end",
				reason: "manual",
				result: { tokensBefore: 1_000, estimatedTokensAfter: 200 },
				aborted: false,
				willRetry: false,
			},
		},
		{ sessionId: asSessionId("a"), event: agentEnd },
		{ sessionId: asSessionId("a"), event: agentSettled() },
	]);
	unsubscribe();

	expect(commits).toBe(1);
	expect(rt(asSessionId("a")).statsRefreshTick).toBe(3);
	store.handlePiEvent(toolEnd("t1", {}), asSessionId("a"));
	expect(rt(asSessionId("a")).statsRefreshTick).toBe(3);
	store.handlePiEvent({ type: "entry_appended", entryType: "custom" }, asSessionId("a"));
	expect(rt(asSessionId("a")).statsRefreshTick).toBe(3);
	for (const [index, entryType] of [
		"usage",
		"compaction",
		"branch_summary",
		"context_edit",
	].entries()) {
		store.handlePiEvent({ type: "entry_appended", entryType }, asSessionId("a"));
		expect(rt(asSessionId("a")).statsRefreshTick).toBe(4 + index);
	}
});

test("a host-fired USER message folds into the transcript; the composer's optimistic twin doesn't duplicate", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(userStart("<review pkg>"), asSessionId("a"));
	expect(rt(asSessionId("a")).turns).toHaveLength(1);
	expect(rt(asSessionId("a")).turns[0]?.kind).toBe("user");

	store.appendUserMessage(asSessionId("a"), "fix the tests");
	store.handlePiEvent(userStart("fix the tests"), asSessionId("a"));
	expect(rt(asSessionId("a")).turns.filter((t) => t.kind === "user")).toHaveLength(2);

	store.handlePiEvent(userStart("[thinkrail:todo-nudge] plan changed"), asSessionId("a"));
	expect(rt(asSessionId("a")).turns.filter((t) => t.kind === "user")).toHaveLength(2);
});

test("a matching user echo adopts the host clock while retaining optimistic identity and attachment labels", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("clock"), null, "medium");
	store.appendUserMessage(asSessionId("clock"), "fix the tests", [
		{ name: "screen.png", content: { type: "image", data: "test", mimeType: "image/png" } },
	]);
	const optimistic = rt(asSessionId("clock")).turns[0];
	if (optimistic?.kind !== "user") throw new Error("optimistic turn missing");
	const message = {
		role: "user" as const,
		content: [{ type: "text" as const, text: "fix the tests" }],
		timestamp: 1_000,
	};
	store.handlePiEvent({ type: "message_start", message }, asSessionId("clock"));
	expect(rt(asSessionId("clock")).turns).toEqual([{ ...optimistic, message }]);
	expect(rt(asSessionId("clock")).turns[0]).toMatchObject({ attachmentNames: ["screen.png"] });
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
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	store.handlePiEvent(agentStart, asSessionId("a"));
	store.handlePiEvent(assistantStart, asSessionId("a"));
	store.handlePiEvent(assistantText("first reply"), asSessionId("a"));

	store.handlePiEvent(queueUpdate(["course-correct"], ["queued question"], true), asSessionId("a"));
	expect(rt(asSessionId("a")).queue).toEqual({
		steering: ["course-correct"],
		followUp: ["queued question"],
		hasImages: true,
	});
	expect(rt(asSessionId("a")).turns.filter((t) => t.kind === "user")).toHaveLength(0);

	store.handlePiEvent(queueUpdate([], ["queued question"]), asSessionId("a"));
	store.handlePiEvent(userStart("course-correct"), asSessionId("a"));
	store.handlePiEvent(queueUpdate([], []), asSessionId("a"));
	store.handlePiEvent(userStart("queued question"), asSessionId("a"));

	const turns = rt(asSessionId("a")).turns;
	expect(turns.map((t) => t.kind)).toEqual(["assistant", "user", "user"]);
	expect(rt(asSessionId("a")).queue).toEqual({ steering: [], followUp: [] });
});

test("normalized session snapshots and pushes gate acknowledgement on the exact rendered result", () => {
	const record = (completionId: string): SessionStateRecord => ({
		sessionId: asSessionId("state-session"),
		workspaceId: asWorkspaceId("state-workspace"),
		projectId: asProjectId("state-project"),
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
			asWorkspaceId("state-workspace"),
			asSessionId("state-session"),
		);
	const store = useAppStore.getState();
	store.setStatus("connected");
	store.openChatSession(
		asWorkspaceId("state-workspace"),
		asSessionId("state-session"),
		null,
		"medium",
	);
	store.installSessionStateSnapshot([record("completion:one")]);
	expect(useAppStore.getState().sessions["state-session"]?.hostState).toEqual(
		record("completion:one").state,
	);
	expect(ready()).toBeNull();
	store.noteRenderedCompletion(asSessionId("state-session"), "completion:one");
	expect(ready()).toBe("completion:one");

	store.applySessionState(record("completion:two"));
	expect(ready()).toBeNull();
	store.noteRenderedCompletion(asSessionId("state-session"), "completion:one");
	expect(ready()).toBeNull();
	store.noteRenderedCompletion(asSessionId("state-session"), "completion:two");
	expect(ready()).toBe("completion:two");

	store.setStatus("disconnected");
	store.setStatus("connected");
	expect(ready()).toBeNull();

	store.deleteChat(asWorkspaceId("state-workspace"), asSessionId("state-session"));
	expect(
		useAppStore.getState().sessionStateByWorkspace["state-workspace"]?.["state-session"],
	).toBeUndefined();
	expect(ready()).toBeNull();
});

test("hydrateSession seeds the queue from the summary snapshot", () => {
	const store = useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws1") });
	const summary: SessionSummary = {
		sessionId: asSessionId("q1"),
		workspaceId: asWorkspaceId("ws1"),
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
	expect(rt(asSessionId("q1")).queue).toEqual({ steering: [], followUp: ["waiting in line"] });

	const { queue, ...bare } = summary;
	void queue;
	store.hydrateSession({ ...bare, sessionId: asSessionId("q2") }, emptyHydration());
	expect(rt(asSessionId("q2")).queue).toEqual({ steering: [], followUp: [] });
});

test("Pi's expanded skill echo replaces its matching optimistic slash command in place", () => {
	const expanded =
		'<skill name="review" location="/repo/.pi/skills/review/SKILL.md">\nReferences are relative to /repo/.pi/skills/review.\n\n# Review\n\nInspect the diff.\n</skill>\n\nFocus on src/app.ts.';
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("skill"), null, "medium");
	store.appendUserMessage(asSessionId("skill"), "/skill:review Focus on src/app.ts.");
	const optimistic = rt(asSessionId("skill")).turns[0];
	if (optimistic?.kind !== "user") throw new Error("optimistic turn missing");

	store.handlePiEvent(userStart(expanded), asSessionId("skill"));
	const turns = rt(asSessionId("skill")).turns;
	expect(turns).toHaveLength(1);
	const canonical = turns[0];
	expect(canonical?.id).toBe(optimistic.id);
	expect(canonical?.kind === "user" && userText(canonical.message.content)).toBe(expanded);

	store.openChatSession(asWorkspaceId("ws1"), asSessionId("mismatch"), null, "medium");
	store.appendUserMessage(asSessionId("mismatch"), "/skill:other Focus on src/app.ts.");
	store.handlePiEvent(userStart(expanded), asSessionId("mismatch"));
	expect(rt(asSessionId("mismatch")).turns.filter((turn) => turn.kind === "user")).toHaveLength(2);
});

test("an assistant turn is built (and replaced, not duplicated) from message_update partials", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, asSessionId("a"));
	store.handlePiEvent(assistantStart, asSessionId("a"));
	store.handlePiEvent(assistantText("po"), asSessionId("a"));
	store.handlePiEvent(assistantText("pong"), asSessionId("a"));

	const assistants = rt(asSessionId("a")).turns.filter((t) => t.kind === "assistant");
	expect(assistants).toHaveLength(1);
	const turn = assistants[0];
	expect(turn?.kind === "assistant" && turn.streaming).toBe(true);
	expect(turn?.kind === "assistant" && turn.message.content[0]?.type === "text").toBe(true);

	store.handlePiEvent(agentEnd, asSessionId("a"));
	expect(rt(asSessionId("a")).isStreaming).toBe(true);
	store.handlePiEvent(agentSettled(), asSessionId("a"));
	const after = rt(asSessionId("a"));
	expect(after.isStreaming).toBe(false);
	expect(after.currentAssistantId).toBeNull();
	expect(after.turns.some((t) => t.kind === "system" && t.text === undefined)).toBe(true);
});

test("a multi-message turn leaves no assistant turn flagged streaming (no stray live indicator)", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, asSessionId("a"));
	store.handlePiEvent(assistantStart, asSessionId("a"));
	store.handlePiEvent(assistantText("first"), asSessionId("a"));
	store.handlePiEvent(assistantStart, asSessionId("a"));
	expect(
		rt(asSessionId("a")).turns.filter((t) => t.kind === "assistant" && t.streaming),
	).toHaveLength(0);
	store.handlePiEvent(assistantText("second"), asSessionId("a"));
	const streamingMid = rt(asSessionId("a")).turns.filter(
		(t) => t.kind === "assistant" && t.streaming,
	);
	expect(streamingMid).toHaveLength(1);

	store.handlePiEvent(agentEnd, asSessionId("a"));
	expect(rt(asSessionId("a")).turns.some((t) => t.kind === "assistant" && t.streaming)).toBe(true);
	store.handlePiEvent(agentSettled(), asSessionId("a"));
	const after = rt(asSessionId("a"));
	expect(after.turns.filter((t) => t.kind === "assistant")).toHaveLength(2);
	expect(after.turns.some((t) => t.kind === "assistant" && t.streaming)).toBe(false);
	expect(after.isStreaming).toBe(false);
});

test("message_end finalizes the turn the moment its message completes (not at agent_end)", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, asSessionId("a"));
	store.handlePiEvent(assistantStart, asSessionId("a"));
	store.handlePiEvent(assistantText("asking…"), asSessionId("a"));
	expect(rt(asSessionId("a")).turns.some((t) => t.kind === "assistant" && t.streaming)).toBe(true);

	const finalMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "ask1", name: "ask_user_question", arguments: {} }],
		stopReason: "toolUse",
	};
	store.handlePiEvent(
		{ type: "message_end", message: finalMessage } as unknown as PiEvent,
		asSessionId("a"),
	);

	const after = rt(asSessionId("a"));
	expect(after.isStreaming).toBe(true);
	expect(after.currentAssistantId).toBeNull();
	const turn = after.turns.find((t) => t.kind === "assistant");
	expect(turn?.kind === "assistant" && turn.streaming).toBe(false);
	expect(turn?.kind === "assistant" && turn.message.stopReason).toBe("toolUse");

	const before = rt(asSessionId("a"));
	store.handlePiEvent(
		{ type: "message_end", message: { role: "toolResult" } } as unknown as PiEvent,
		asSessionId("a"),
	);
	const ignored = rt(asSessionId("a"));
	expect(ignored.turns).toBe(before.turns);
	expect(ignored.eventRevision).toBe(before.eventRevision + 1);
});

test("a tool-response custom message_end indexes into toolResponses (never the turn list)", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

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
		asSessionId("a"),
	);
	expect(rt(asSessionId("a")).toolResponses.ask1).toEqual(response);
	expect(
		rt(asSessionId("a")).turns.filter((t) => t.kind === "assistant" || t.kind === "user"),
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
		asSessionId("a"),
	);
	expect(rt(asSessionId("a")).toolResponses).toEqual({ ask1: response, ask2: "free text" });

	const before = rt(asSessionId("a"));
	store.handlePiEvent(
		{
			type: "message_end",
			message: { role: "custom", customType: "other", content: "x", display: false },
		} as unknown as PiEvent,
		asSessionId("a"),
	);
	const ignored = rt(asSessionId("a"));
	expect(ignored.turns).toBe(before.turns);
	expect(ignored.toolResponses).toBe(before.toolResponses);
	expect(ignored.eventRevision).toBe(before.eventRevision + 1);
});

test("a legacy ask-user-answers custom message_end (details.result) indexes into toolResponses too", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

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
		asSessionId("a"),
	);
	expect(rt(asSessionId("a")).toolResponses.ask1).toEqual(result);
	expect(
		rt(asSessionId("a")).turns.filter((t) => t.kind === "assistant" || t.kind === "user"),
	).toHaveLength(0);
});

test("a subagent-completion custom message_end appends a subagentCompletion turn", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	const details = {
		childSessionId: asSessionId("child-1"),
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
		asSessionId("a"),
	);
	const turn = rt(asSessionId("a")).turns.at(-1);
	expect(turn?.kind).toBe("subagentCompletion");
	expect(turn?.kind === "subagentCompletion" && turn.details.childSessionId).toBe("child-1");
	expect(turn?.kind === "subagentCompletion" && turn.text).toContain("the report");
	expect(turn?.kind === "subagentCompletion" && turn.timestamp).toBe(4_200);

	const before = rt(asSessionId("a"));
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
		asSessionId("a"),
	);
	const ignored = rt(asSessionId("a"));
	expect(ignored.turns).toBe(before.turns);
	expect(ignored.eventRevision).toBe(before.eventRevision + 1);
});

test("a todo-review-fix custom message_end appends a reviewFix turn", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

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
		asSessionId("a"),
	);
	const turn = rt(asSessionId("a")).turns.at(-1);
	expect(turn?.kind).toBe("reviewFix");
	expect(turn?.kind === "reviewFix" && turn.details.itemId).toBe("t_1");
	expect(turn?.kind === "reviewFix" && turn.details.comments[0]?.id).toBe("c_1");
	expect(turn?.kind === "reviewFix" && turn.text).toContain("Address each review comment");

	const reviewBefore = rt(asSessionId("a"));
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
		asSessionId("a"),
	);
	const reviewIgnored = rt(asSessionId("a"));
	expect(reviewIgnored.turns).toBe(reviewBefore.turns);
	expect(reviewIgnored.eventRevision).toBe(reviewBefore.eventRevision + 1);
});

test("the tool lifecycle folds into toolResults (the status + raw the renderers read)", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(toolStart("t1"), asSessionId("a"));
	expect(rt(asSessionId("a")).toolResults.t1).toEqual({ status: "running", raw: undefined });

	const partial = { content: [{ type: "text", text: "partial" }] };
	store.handlePiEvent(toolUpdate("t1", partial), asSessionId("a"));
	expect(rt(asSessionId("a")).toolResults.t1).toEqual({ status: "running", raw: partial });

	const final = { content: [{ type: "text", text: "done" }] };
	store.handlePiEvent(toolEnd("t1", final), asSessionId("a"));
	expect(rt(asSessionId("a")).toolResults.t1).toEqual({ status: "done", raw: final });
});

test("a failed tool ends in the error status (the red-path the renderers branch on)", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(toolStart("t1"), asSessionId("a"));
	const errResult = { content: [{ type: "text", text: "boom" }] };
	store.handlePiEvent(toolEnd("t1", errResult, true), asSessionId("a"));
	expect(rt(asSessionId("a")).toolResults.t1).toEqual({ status: "error", raw: errResult });
});

test("auto-retry adds a countdown turn, and resolving it clears the indicator", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(retryStart(2, 3, 5_000), asSessionId("a"));
	const retry = rt(asSessionId("a")).turns.find((t) => t.kind === "retry");
	expect(retry?.kind === "retry" && retry.source).toBe("turn");
	expect(retry?.kind === "retry" && retry.attempt).toBe(2);
	expect(retry?.kind === "retry" && retry.maxAttempts).toBe(3);
	expect(retry?.kind === "retry" && retry.delayMs).toBe(5_000);

	store.handlePiEvent(retryEnd, asSessionId("a"));
	expect(rt(asSessionId("a")).turns.some((t) => t.kind === "retry")).toBe(false);
});

test("summarization retries show their own countdown; re-scheduling replaces, finished clears", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(summarizationScheduled(1, 3, 2_000), asSessionId("a"));
	const first = rt(asSessionId("a")).turns.find((t) => t.kind === "retry");
	expect(first?.kind === "retry" && first.source).toBe("summarization");
	expect(first?.kind === "retry" && first.attempt).toBe(1);

	store.handlePiEvent(summarizationScheduled(2, 3, 4_000), asSessionId("a"));
	const retries = rt(asSessionId("a")).turns.filter((t) => t.kind === "retry");
	expect(retries.length).toBe(1);
	expect(retries[0]?.kind === "retry" && retries[0].attempt).toBe(2);

	store.handlePiEvent(summarizationFinished, asSessionId("a"));
	expect(rt(asSessionId("a")).turns.some((t) => t.kind === "retry")).toBe(false);
});

test("overlapping turn + summarization retries never clear each other", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(retryStart(1, 3, 1_000), asSessionId("a"));
	store.handlePiEvent(summarizationScheduled(1, 3, 2_000), asSessionId("a"));
	expect(rt(asSessionId("a")).turns.filter((t) => t.kind === "retry").length).toBe(2);

	store.handlePiEvent(retryEnd, asSessionId("a"));
	const left = rt(asSessionId("a")).turns.filter((t) => t.kind === "retry");
	expect(left.length).toBe(1);
	expect(left[0]?.kind === "retry" && left[0].source).toBe("summarization");

	store.handlePiEvent(summarizationFinished, asSessionId("a"));
	expect(rt(asSessionId("a")).turns.some((t) => t.kind === "retry")).toBe(false);
});

test("a lingering retry countdown is swept up only when the run settles", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, asSessionId("a"));
	store.handlePiEvent(retryStart(1, 3, 1_000), asSessionId("a"));
	store.handlePiEvent(agentEnd, asSessionId("a"));
	expect(rt(asSessionId("a")).turns.some((t) => t.kind === "retry")).toBe(true);
	store.handlePiEvent(agentSettled(), asSessionId("a"));
	expect(rt(asSessionId("a")).turns.some((t) => t.kind === "retry")).toBe(false);
	expect(rt(asSessionId("a")).turns.some((t) => t.kind === "system" && t.text === undefined)).toBe(
		true,
	);
});

test("auto-retry drops the failed attempt's turn — the retried message must not render twice", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, asSessionId("a"));
	store.handlePiEvent(assistantStart, asSessionId("a"));
	store.handlePiEvent(assistantText("The answer is"), asSessionId("a"));
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
		asSessionId("a"),
	);
	store.handlePiEvent(
		{ type: "agent_end", willRetry: true, messages: [] } as unknown as PiEvent,
		asSessionId("a"),
	);
	store.handlePiEvent(retryStart(1, 3, 2_000), asSessionId("a"));
	expect(rt(asSessionId("a")).turns.some((t) => t.kind === "retry")).toBe(true);

	store.handlePiEvent(agentStart, asSessionId("a"));
	store.handlePiEvent(assistantStart, asSessionId("a"));
	store.handlePiEvent(assistantText("The answer is 4"), asSessionId("a"));
	store.handlePiEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "The answer is 4" }],
				stopReason: "stop",
			},
		} as unknown as PiEvent,
		asSessionId("a"),
	);
	store.handlePiEvent(agentEnd, asSessionId("a"));
	store.handlePiEvent(agentSettled(), asSessionId("a"));

	const after = rt(asSessionId("a"));
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
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	store.appendUserMessage(asSessionId("a"), "hi");

	store.handlePiEvent(agentStart, asSessionId("a"));
	store.handlePiEvent(
		{ type: "agent_end", willRetry: true, messages: [] } as unknown as PiEvent,
		asSessionId("a"),
	);
	store.handlePiEvent(retryStart(1, 3, 2_000), asSessionId("a"));
	expect(rt(asSessionId("a")).turns.filter((t) => t.kind === "user")).toHaveLength(1);
	expect(rt(asSessionId("a")).turns.some((t) => t.kind === "retry")).toBe(true);
});

test("a turn that ends in a provider error surfaces the error (not a false ✓ Done)", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, asSessionId("a"));
	store.handlePiEvent(agentEndError("model 'gpt-5.5' not found"), asSessionId("a"));
	expect(rt(asSessionId("a")).isStreaming).toBe(true);
	store.handlePiEvent(
		agentSettled({ stopReason: "error", errorMessage: "model 'gpt-5.5' not found" }),
		asSessionId("a"),
	);

	const after = rt(asSessionId("a"));
	expect(after.isStreaming).toBe(false);
	const err = after.turns.find((t) => t.kind === "error");
	expect(err?.kind === "error" && err.text).toContain("gpt-5.5");
	expect(failureRecovery(asSessionId("a"))).toBe("try-again");
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
				sessionId: asSessionId("a"),
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
		store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
		store.handlePiEvent(agentStart, asSessionId("a"));
		store.handlePiEvent(stopped, asSessionId("a"));
		store.handlePiEvent(agentEnd, asSessionId("a"));
		store.handlePiEvent(agentSettled(terminal), asSessionId("a"));
		expect(
			rt(asSessionId("a"))
				.turns.map((turn) => turn.kind)
				.slice(-2),
		).toEqual([closer, "backgroundCommandCompletion"]);
		store.closeChatRuntime(asSessionId("a"));
	}
});

test("a terminal length stop is a visible failure, never a false ✓ Done", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, asSessionId("a"));
	store.handlePiEvent(agentEnd, asSessionId("a"));
	store.handlePiEvent(agentSettled({ stopReason: "length" }), asSessionId("a"));

	const after = rt(asSessionId("a"));
	const error = after.turns.find((turn) => turn.kind === "error");
	expect(error?.kind === "error" && error.failure).toBe("truncated");
	expect(failureRecovery(asSessionId("a"))).toBe("try-again");
	expect(after.turns.some((turn) => turn.kind === "system" && turn.text === undefined)).toBe(false);
	expect(after.isStreaming).toBe(false);
});

test("a local follow-on consumes only its session's failure recovery", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("b"), null, "medium");
	for (const sessionId of ["a", "b"]) {
		store.handlePiEvent(
			agentSettled({ stopReason: "error", errorMessage: "fetch failed" }),
			asSessionId(sessionId),
		);
	}

	store.appendUserMessage(asSessionId("a"), "Try again.");

	expect(failureRecovery(asSessionId("a"))).toBeUndefined();
	expect(failureRecovery(asSessionId("b"))).toBe("try-again");
});

test("another client's agent start consumes only its session's failure recovery", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("b"), null, "medium");
	for (const sessionId of ["a", "b"]) {
		store.handlePiEvent(
			agentSettled({ stopReason: "error", errorMessage: "fetch failed" }),
			asSessionId(sessionId),
		);
	}

	store.handlePiEvent(agentStart, asSessionId("b"));

	expect(failureRecovery(asSessionId("a"))).toBe("try-again");
	expect(failureRecovery(asSessionId("b"))).toBeUndefined();
});

test("a successful overflow compaction removes the superseded assistant attempt", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, asSessionId("a"));
	store.handlePiEvent(assistantStart, asSessionId("a"));
	store.handlePiEvent(assistantText("incomplete"), asSessionId("a"));
	store.handlePiEvent(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "incomplete" }],
				stopReason: "length",
			},
		} as unknown as PiEvent,
		asSessionId("a"),
	);
	store.handlePiEvent(agentEnd, asSessionId("a"));
	expect(rt(asSessionId("a")).turns.filter((turn) => turn.kind === "assistant")).toHaveLength(1);

	store.handlePiEvent(recoveredOverflow, asSessionId("a"));
	expect(rt(asSessionId("a")).turns.filter((turn) => turn.kind === "assistant")).toHaveLength(0);
	expect(rt(asSessionId("a")).isStreaming).toBe(true);
});

test("overflow recovery never removes an older failure when this attempt was not observed", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, asSessionId("a"));
	store.handlePiEvent(assistantStart, asSessionId("a"));
	store.handlePiEvent(assistantText("old failed answer"), asSessionId("a"));
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
		asSessionId("a"),
	);
	store.handlePiEvent(agentEndError("old failure"), asSessionId("a"));
	store.handlePiEvent(
		agentSettled({ stopReason: "error", errorMessage: "old failure" }),
		asSessionId("a"),
	);
	expect(rt(asSessionId("a")).turns.filter((turn) => turn.kind === "assistant")).toHaveLength(1);

	store.handlePiEvent(agentStart, asSessionId("a"));
	store.handlePiEvent(agentEnd, asSessionId("a"));
	store.handlePiEvent(recoveredOverflow, asSessionId("a"));

	expect(rt(asSessionId("a")).turns.filter((turn) => turn.kind === "assistant")).toHaveLength(1);
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
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, asSessionId("a"));
	store.handlePiEvent(agentEnd, asSessionId("a"));
	store.handlePiEvent(compactionStart(), asSessionId("a"));
	const running = compactionTurns(asSessionId("a"));
	expect(running).toMatchObject([{ status: "running" }]);
	expect(rt(asSessionId("a")).isStreaming).toBe(true);
	expect(
		rt(asSessionId("a")).turns.filter((turn) => turn.kind === "system" && turn.text === undefined),
	).toHaveLength(0);

	store.handlePiEvent(compactionEnd(), asSessionId("a"));
	expect(compactionTurns(asSessionId("a"))).toMatchObject([
		{ id: running[0]?.id, status: "done", tokensBefore: 268_909, tokensAfter: 12_000 },
	]);

	store.handlePiEvent(agentSettled(), asSessionId("a"));
	const turns = rt(asSessionId("a")).turns;
	expect(turns.at(-1)).toMatchObject({ kind: "system" });
	expect(turns.at(-2)).toMatchObject({ kind: "compaction", status: "done" });
});

test("the incident sequence: truncated response → compacting → compacted-resuming, never a misleading Done", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, asSessionId("a"));
	store.handlePiEvent(assistantStart, asSessionId("a"));
	store.handlePiEvent(assistantText(""), asSessionId("a"));
	store.handlePiEvent(
		{
			type: "message_end",
			message: { role: "assistant", content: [], stopReason: "length" },
		} as unknown as PiEvent,
		asSessionId("a"),
	);
	store.handlePiEvent(agentEnd, asSessionId("a"));
	store.handlePiEvent(compactionStart("overflow"), asSessionId("a"));
	expect(compactionTurns(asSessionId("a"))).toMatchObject([{ status: "running" }]);

	store.handlePiEvent(
		compactionEnd({ reason: "overflow", willRetry: true, result: { tokensBefore: 268_909 } }),
		asSessionId("a"),
	);
	expect(compactionTurns(asSessionId("a"))).toMatchObject([
		{ status: "done", resuming: true, tokensBefore: 268_909 },
	]);
	expect(rt(asSessionId("a")).turns.filter((turn) => turn.kind === "assistant")).toHaveLength(0);
	expect(rt(asSessionId("a")).isStreaming).toBe(true);
	expect(
		rt(asSessionId("a")).turns.filter((turn) => turn.kind === "system" && turn.text === undefined),
	).toHaveLength(0);

	store.handlePiEvent(agentStart, asSessionId("a"));
	store.handlePiEvent(assistantStart, asSessionId("a"));
	store.handlePiEvent(assistantText("finished the rebase"), asSessionId("a"));
	store.handlePiEvent(agentEnd, asSessionId("a"));
	store.handlePiEvent(agentSettled(), asSessionId("a"));
	expect(rt(asSessionId("a")).turns.at(-1)).toMatchObject({ kind: "system" });
	expect(rt(asSessionId("a")).isStreaming).toBe(false);
	expect(compactionTurns(asSessionId("a"))[0]?.resuming).toBeUndefined();
});

test("a failed compaction settles into a visible, actionable notice — and a cancelled one into a muted record", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(compactionStart("manual"), asSessionId("a"));
	store.handlePiEvent(
		compactionEnd({ reason: "manual", result: undefined, errorMessage: "Compaction failed: boom" }),
		asSessionId("a"),
	);
	expect(compactionTurns(asSessionId("a"))).toMatchObject([
		{ status: "failed", detail: "Compaction failed: boom" },
	]);

	store.handlePiEvent(compactionStart("manual"), asSessionId("a"));
	store.handlePiEvent(
		compactionEnd({ reason: "manual", result: undefined, aborted: true }),
		asSessionId("a"),
	);
	expect(compactionTurns(asSessionId("a"))).toMatchObject([
		{ status: "failed" },
		{ status: "cancelled" },
	]);
});

test("manual compaction rejection appends one failed row only when no lifecycle was observed", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	const beforeEarlyFailure = selectCompactionTurnIds(useAppStore.getState(), asSessionId("a"));
	store.appendCompactionFailureUnlessObserved(
		asSessionId("a"),
		beforeEarlyFailure,
		"host unavailable",
	);
	expect(compactionTurns(asSessionId("a"))).toMatchObject([
		{ status: "failed", detail: "host unavailable" },
	]);

	const beforePiFailure = selectCompactionTurnIds(useAppStore.getState(), asSessionId("a"));
	store.handlePiEvent(compactionStart("manual"), asSessionId("a"));
	store.handlePiEvent(
		compactionEnd({ reason: "manual", result: undefined, errorMessage: "Nothing to compact" }),
		asSessionId("a"),
	);
	store.appendCompactionFailureUnlessObserved(
		asSessionId("a"),
		beforePiFailure,
		"request rejected",
	);

	expect(compactionTurns(asSessionId("a"))).toMatchObject([
		{ status: "failed", detail: "host unavailable" },
		{ status: "failed", detail: "Nothing to compact" },
	]);
});

test("a compaction_end with no observed start still lands a settled notice (connected mid-compaction)", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(compactionEnd(), asSessionId("a"));
	expect(compactionTurns(asSessionId("a"))).toMatchObject([
		{ status: "done", tokensBefore: 268_909, tokensAfter: 12_000 },
	]);
});

test("compact-and-retry produces one completion marker at final settlement", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(agentStart, asSessionId("a"));
	store.handlePiEvent(agentEnd, asSessionId("a"));
	store.handlePiEvent(recoveredOverflow, asSessionId("a"));
	store.handlePiEvent(agentStart, asSessionId("a"));
	store.handlePiEvent(agentEnd, asSessionId("a"));
	expect(
		rt(asSessionId("a")).turns.filter((turn) => turn.kind === "system" && turn.text === undefined),
	).toHaveLength(0);

	store.handlePiEvent(agentSettled(), asSessionId("a"));
	expect(
		rt(asSessionId("a")).turns.filter((turn) => turn.kind === "system" && turn.text === undefined),
	).toHaveLength(1);
});

test("appendErrorTurn surfaces a failed send (a rejected prompt) as a visible error turn", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.appendUserMessage(asSessionId("a"), "do the thing");
	store.appendErrorTurn(asSessionId("a"), "No API key configured for provider openai");

	const err = rt(asSessionId("a")).turns.find((t) => t.kind === "error");
	expect(err?.kind === "error" && err.text).toContain("No API key");
	expect(failureRecovery(asSessionId("a"))).toBeUndefined();
	expect(rt(asSessionId("a")).isStreaming).toBe(false);
});

test("a rejected queued send cannot settle work the host is still running", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	store.handlePiEvent(agentStart, asSessionId("a"));
	store.handlePiEvent(assistantStart, asSessionId("a"));
	store.handlePiEvent(assistantText("still working"), asSessionId("a"));
	const currentAssistantId = rt(asSessionId("a")).currentAssistantId;

	store.appendErrorTurn(asSessionId("a"), "follow-up rejected");

	expect(rt(asSessionId("a")).isStreaming).toBe(true);
	expect(rt(asSessionId("a")).currentAssistantId).toBe(currentAssistantId);
	expect(rt(asSessionId("a")).turns.at(-1)).toMatchObject({
		kind: "error",
		text: "follow-up rejected",
	});
});

test("a message_update with no prior message_start still builds the turn (mid-stream hydration)", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.handlePiEvent(assistantText("partial reply"), asSessionId("a"));
	expect(rt(asSessionId("a")).turns.filter((t) => t.kind === "assistant")).toHaveLength(1);
	expect(rt(asSessionId("a")).currentAssistantId).not.toBeNull();

	store.handlePiEvent(assistantText("partial reply"), asSessionId("a"));
	expect(rt(asSessionId("a")).turns.filter((t) => t.kind === "assistant")).toHaveLength(1);
});

test("a durable session title event renames an open chat without moving attention", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("named"), null, "medium");
	const before = useAppStore.getState();
	const activeTab = before.activeTabByWorkspace.ws1;
	const navTick = before.navTickByWorkspace.ws1;

	store.handlePiEvent(sessionTitleChanged("Fix auth redirect"), asSessionId("named"));

	const after = useAppStore.getState();
	expect(
		after.tabsByWorkspace.ws1?.find((tab) => tab.kind === "chat" && tab.sessionId === "named")
			?.name,
	).toBe("Fix auth redirect");
	expect(after.activeTabByWorkspace.ws1).toBe(activeTab);
	expect(after.navTickByWorkspace.ws1).toBe(navTick);
	expect(rt(asSessionId("named")).eventRevision).toBe(1);
});

test("a durable session title event renames the chat's plan tab with it, open or closed", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("planned"), null, "medium");
	store.openDoc({
		kind: "plan",
		id: "ws1:plan:planned",
		workspaceId: asWorkspaceId("ws1"),
		name: "",
		sessionId: asSessionId("planned"),
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

	store.handlePiEvent(sessionTitleChanged("Auth refactor"), asSessionId("planned"));
	expect(planName()).toBe("Auth refactor");
	expect(queuedPlanName()).toBe("Auth refactor");

	store.closeChatToHistory(asSessionId("planned"), true, asWorkspaceId("ws1"));
	store.handlePiEvent(sessionTitleChanged("Auth refactor, take two"), asSessionId("planned"));
	expect(planName()).toBe("Auth refactor, take two");
	expect(useAppStore.getState().closedChatsByWorkspace.ws1?.[0]?.title).toBe(
		"Auth refactor, take two",
	);
});

test("a durable title refreshes a placed plan document's name without requesting activation", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("placed-plan"), null, "medium");
	useAppStore.setState((state) => ({
		tabsByWorkspace: {
			...state.tabsByWorkspace,
			ws1: [
				...(state.tabsByWorkspace.ws1 ?? []),
				{
					kind: "plan",
					id: "plan-cache",
					workspaceId: asWorkspaceId("ws1"),
					name: "",
					sessionId: asSessionId("placed-plan"),
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
						{ kind: "chat", id: "chat-placement", name: "", sessionId: asSessionId("placed-plan") },
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

	store.handlePiEvent(sessionTitleChanged("Auth refactor"), asSessionId("placed-plan"));

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
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("closed-title"), null, "medium");
	store.closeChatToHistory(asSessionId("closed-title"), true, asWorkspaceId("ws1"));

	store.handlePiEvent(sessionTitleChanged("Closed work"), asSessionId("closed-title"));
	expect(useAppStore.getState().closedChatsByWorkspace.ws1?.[0]?.title).toBe("Closed work");
	store.handlePiEvent(sessionTitleChanged(), asSessionId("closed-title"));
	expect(useAppStore.getState().closedChatsByWorkspace.ws1?.[0]?.title).toBe("");
});

test("a durable title updates a known tab without conjuring a runtime or title-event buffer", () => {
	useAppStore.setState({
		tabsByWorkspace: {
			ws1: [
				{
					kind: "chat",
					id: chatTabId(asWorkspaceId("ws1"), asSessionId("tab-only-title")),
					workspaceId: asWorkspaceId("ws1"),
					name: "Chat",
					sessionId: asSessionId("tab-only-title"),
				},
			],
		},
	});
	const sessions = useAppStore.getState().sessions;

	useAppStore
		.getState()
		.handlePiEvent(sessionTitleChanged("Named before hydrate"), asSessionId("tab-only-title"));

	const after = useAppStore.getState();
	expect(after.tabsByWorkspace.ws1?.[0]?.name).toBe("Named before hydrate");
	expect(after.sessions).toBe(sessions);
	expect(after.extUiOrphans).toEqual([]);
});

test("an event for an unknown session is a no-op (no runtime is conjured)", () => {
	const before = useAppStore.getState();
	before.handlePiEvent(agentStart, asSessionId("ghost"));
	useAppStore.getState().handlePiEvent(sessionTitleChanged("Ghost title"), asSessionId("ghost"));
	const after = useAppStore.getState();
	expect(after.sessions).toBe(before.sessions);
	expect(after.sessions.ghost).toBeUndefined();
	expect(after.tabsByWorkspace).toBe(before.tabsByWorkspace);
	expect(after.extUiOrphans).toEqual([]);
});

test("closeChatRuntime drops only its own runtime", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("b"), null, "medium");
	store.handlePiEvent(agentStart, asSessionId("b"));

	store.closeChatRuntime(asSessionId("a"));
	expect(useAppStore.getState().sessions.a).toBeUndefined();
	expect(rt(asSessionId("b")).isStreaming).toBe(true);
});

test("applyExtUi routes a dialog to its session; the reply clears only that one", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("b"), null, "medium");

	const dialog: ExtUiRequest = {
		id: "d1",
		sessionId: asSessionId("a"),
		kind: "confirm",
		title: "Proceed?",
		message: "Apply?",
	};
	store.applyExtUi(dialog);
	expect(rt(asSessionId("a")).pendingExtUi?.id).toBe("d1");
	expect(rt(asSessionId("b")).pendingExtUi).toBeNull();

	store.clearPendingExtUi(asSessionId("a"), "d1");
	expect(rt(asSessionId("a")).pendingExtUi).toBeNull();
});

test("applyExtUi reads a notify's level: only an error becomes an error turn", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	store.applyExtUi({
		id: "n1",
		sessionId: asSessionId("a"),
		kind: "notify",
		message: "Just so you know",
		level: "info",
	});
	store.applyExtUi({
		id: "n2",
		sessionId: asSessionId("a"),
		kind: "notify",
		message: "Careful",
		level: "warning",
	});
	store.applyExtUi({
		id: "n3",
		sessionId: asSessionId("a"),
		kind: "notify",
		message: "Extension theme-probe.ts failed on session_start: theme.fg is not a function",
		level: "error",
	});

	expect(rt(asSessionId("a")).turns.slice(-3)).toMatchObject([
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
		sessionId: asSessionId("late"),
		kind: "setStatus",
		key: "test",
		text: "Theme works",
	});
	store.applyExtUi({
		id: "n1",
		sessionId: asSessionId("late"),
		kind: "notify",
		message: "Extension theme-probe.ts failed on session_start: theme.fg is not a function",
		level: "error",
	});
	expect(useAppStore.getState().sessions.late).toBeUndefined();

	store.openChatSession(asWorkspaceId("ws1"), asSessionId("late"), null, "medium");

	expect(rt(asSessionId("late")).extUiStatus).toEqual({ test: "Theme works" });
	expect(rt(asSessionId("late")).turns.at(-1)).toMatchObject({
		kind: "error",
		text: "Extension theme-probe.ts failed on session_start: theme.fg is not a function",
	});
	expect(useAppStore.getState().extUiOrphans).toEqual([]);
});

test("an extra-usage notice survives the create race, dismisses per chat, and silences every chat", () => {
	const store = useAppStore.getState();
	store.applyExtUi({
		id: "x1",
		sessionId: asSessionId("a"),
		kind: "notice",
		notice: "anthropicExtraUsage",
	});
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("b"), null, "medium");
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("c"), null, "medium");
	store.applyExtUi({
		id: "x2",
		sessionId: asSessionId("b"),
		kind: "notice",
		notice: "anthropicExtraUsage",
	});
	store.applyExtUi({
		id: "x3",
		sessionId: asSessionId("c"),
		kind: "notice",
		notice: "anthropicExtraUsage",
	});
	expect(rt(asSessionId("a")).notice).toBe("anthropicExtraUsage");

	store.dismissSessionNotice(asSessionId("a"));
	expect(rt(asSessionId("a")).notice).toBeNull();
	expect(rt(asSessionId("b")).notice).toBe("anthropicExtraUsage");

	store.silenceNotice("anthropicExtraUsage");
	expect(rt(asSessionId("b")).notice).toBeNull();
	expect(rt(asSessionId("c")).notice).toBeNull();
});

test("Don't warn again also drops a buffered notice for a chat not opened yet", () => {
	const store = useAppStore.getState();
	store.applyExtUi({
		id: "x4",
		sessionId: asSessionId("later"),
		kind: "notice",
		notice: "anthropicExtraUsage",
	});
	store.applyExtUi({
		id: "s4",
		sessionId: asSessionId("later"),
		kind: "setStatus",
		key: "k",
		text: "kept",
	});
	store.silenceNotice("anthropicExtraUsage");
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("later"), null, "medium");
	expect(rt(asSessionId("later")).notice).toBeNull();
	expect(rt(asSessionId("later")).extUiStatus).toEqual({ k: "kept" });
});

test("a dialog for an unknown session is dropped, never replayed as a phantom", () => {
	const store = useAppStore.getState();

	store.applyExtUi({
		id: "d-late",
		sessionId: asSessionId("dialog"),
		kind: "confirm",
		title: "Proceed?",
		message: "Apply?",
	});
	expect(useAppStore.getState().extUiOrphans).toEqual([]);

	store.openChatSession(asWorkspaceId("ws1"), asSessionId("dialog"), null, "medium");
	expect(rt(asSessionId("dialog")).pendingExtUi).toBeNull();
	expect(rt(asSessionId("dialog")).extUiQueue).toEqual([]);
});

test("an exact host-authored pending dialog replays when its session hydrates", () => {
	const store = useAppStore.getState();
	const request = {
		id: "d-authoritative",
		sessionId: asSessionId("dialog-authoritative"),
		kind: "confirm" as const,
		title: "Proceed?",
		message: "Apply?",
	};
	store.installSessionStateSnapshot([
		{
			sessionId: request.sessionId,
			workspaceId: asWorkspaceId("ws1"),
			projectId: asProjectId("p1"),
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

	store.openChatSession(asWorkspaceId("ws1"), request.sessionId, null, "medium");
	expect(rt(request.sessionId).pendingExtUi).toEqual(request);
	expect(useAppStore.getState().extUiOrphans).toEqual([]);
	store.applySessionState({
		sessionId: request.sessionId,
		workspaceId: asWorkspaceId("ws1"),
		projectId: asProjectId("p1"),
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
		sessionId: asSessionId("dialog-peer-cleared"),
		kind: "confirm" as const,
		title: "Proceed?",
		message: "Apply?",
	};
	const base = {
		sessionId: request.sessionId,
		workspaceId: asWorkspaceId("ws1"),
		projectId: asProjectId("p1"),
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
	store.openChatSession(asWorkspaceId("ws1"), request.sessionId, null, "medium");
	expect(rt(request.sessionId).pendingExtUi).toBeNull();
});

test("a frame for a chat closed to history still applies, and orphans stay bounded", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("closed"), null, "medium");
	store.closeChatToHistory(asSessionId("closed"), true, asWorkspaceId("ws1"));

	store.applyExtUi({
		id: "t1",
		sessionId: asSessionId("closed"),
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
			sessionId: asSessionId("never-opened"),
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
					id: chatTabId(asWorkspaceId("ws1"), asSessionId("tab-only")),
					workspaceId: asWorkspaceId("ws1"),
					name: "Chat",
					sessionId: asSessionId("tab-only"),
				},
			],
		},
	});

	store.applyExtUi({
		id: "s1",
		sessionId: asSessionId("tab-only"),
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
		sessionId: asSessionId("reopened"),
		kind: "setStatus",
		key: "test",
		text: "Theme works",
	});
	expect(useAppStore.getState().extUiOrphans).toMatchObject([{ id: "s1" }]);

	const summary: SessionSummary = {
		sessionId: asSessionId("reopened"),
		workspaceId: asWorkspaceId("ws1"),
		title: "Chat",
		model: null,
		thinkingLevel: "medium",
		isStreaming: false,
		messageCount: 0,
		updatedAt: 0,
		live: true,
	};
	store.hydrateSession(summary, emptyHydration());

	expect(rt(asSessionId("reopened")).extUiStatus).toEqual({ test: "Theme works" });
	expect(useAppStore.getState().extUiOrphans).toEqual([]);
});

test("setTitle refreshes shared chat metadata without requesting activation", () => {
	const store = useAppStore.getState();
	const cacheId = chatTabId(asWorkspaceId("ws1"), asSessionId("a"));
	const placementId = "legacy-chat-placement";
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	useAppStore.setState({
		layoutIntents: [],
		layoutDocumentsByWorkspace: {
			ws1: {
				version: 2,
				center: {
					kind: "group",
					id: "center",
					tabs: [{ kind: "chat", id: placementId, name: "Chat", sessionId: asSessionId("a") }],
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
		sessionId: asSessionId("a"),
		kind: "setTitle",
		title: "Migration plan",
	});
	const state = useAppStore.getState();
	expect(state.tabsByWorkspace.ws1?.find((tab) => tab.id === cacheId)?.name).toBe("Migration plan");
	expect(state.layoutIntents).toHaveLength(1);
	expect(state.layoutIntents[0]).toMatchObject({
		kind: "open",
		workspaceId: asWorkspaceId("ws1"),
		intent: "keep",
		activate: false,
		tab: { id: placementId, name: "Migration plan", sessionId: asSessionId("a") },
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
					tabs: [{ kind: "chat", id: placementId, name: "Stale", sessionId: asSessionId("a") }],
				},
			},
		},
	});
	store.applyExtUi({
		id: "title-1b",
		sessionId: asSessionId("a"),
		kind: "setTitle",
		title: "Migration plan",
	});
	expect(useAppStore.getState().layoutIntents[0]).toMatchObject({
		kind: "open",
		tab: { id: placementId, name: "Migration plan", sessionId: asSessionId("a") },
	});

	const cache = useAppStore.getState().tabsByWorkspace.ws1?.find((tab) => tab.id === cacheId);
	if (!cache) throw new Error("missing title cache fixture");
	useAppStore.setState({ layoutIntents: [] });
	store.openTab(cache, "keep", true, { activate: false });
	expect(useAppStore.getState().layoutIntents[0]).toMatchObject({ tab: { id: cacheId } });
	store.applyExtUi({
		id: "title-1c",
		sessionId: asSessionId("a"),
		kind: "setTitle",
		title: "Migration plan",
	});
	expect(useAppStore.getState().layoutIntents[0]).toMatchObject({
		kind: "open",
		tab: { id: placementId, name: "Migration plan", sessionId: asSessionId("a") },
	});
});

test("setTitle cannot restore a cache whose structural close is already accepted", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
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
		sessionId: asSessionId("a"),
		kind: "setTitle",
		title: "Closed title",
	});
	expect(useAppStore.getState().layoutIntents).toEqual([]);
	expect(useAppStore.getState().tabsByWorkspace.ws1?.[0]?.name).toBe("Closed title");
});

test("setTitle repairs the title of a still-live chat in local history", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	store.closeChatToHistory(asSessionId("a"), true, asWorkspaceId("ws1"));
	store.applyExtUi({
		id: "title-3",
		sessionId: asSessionId("a"),
		kind: "setTitle",
		title: "Finished title",
	});
	expect(useAppStore.getState().closedChatsByWorkspace.ws1?.[0]?.title).toBe("Finished title");
});

test("a second dialog for a busy session queues instead of orphaning the first", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	const mk = (id: string): ExtUiRequest => ({
		id,
		sessionId: asSessionId("a"),
		kind: "input",
		title: "name?",
	});
	store.applyExtUi(mk("d1"));
	store.applyExtUi(mk("d2"));
	expect(rt(asSessionId("a")).pendingExtUi?.id).toBe("d1");
	expect(rt(asSessionId("a")).extUiQueue.map((q) => q.id)).toEqual(["d2"]);

	store.clearPendingExtUi(asSessionId("a"), "d1");
	expect(rt(asSessionId("a")).pendingExtUi?.id).toBe("d2");
	expect(rt(asSessionId("a")).extUiQueue).toHaveLength(0);
});

test("closing a chat moves it to history with its runtime kept; reopening restores full state", () => {
	const store = useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws1") });
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	store.handlePiEvent(agentStart, asSessionId("a"));
	useAppStore.setState({
		chatLocationRequest: {
			workspaceId: asWorkspaceId("ws1"),
			projectId: asProjectId("p1"),
			sessionId: asSessionId("a"),
			messageIndex: 0,
			anchorText: "target",
		},
		historyOpenRequest: { id: "history-a", sessionId: asSessionId("a") },
	});

	store.closeChatToHistory(asSessionId("a"));
	let st = useAppStore.getState();
	expect(st.tabsByWorkspace.ws1?.some((t) => t.kind === "chat" && t.sessionId === "a")).toBe(false);
	expect(st.closedChatsByWorkspace.ws1?.map((c) => c.sessionId)).toEqual([asSessionId("a")]);
	expect(st.sessions.a).toBeDefined();
	expect(st.sessions.a?.isStreaming).toBe(true);
	expect(st.chatLocationRequest).toBeNull();
	expect(st.historyOpenRequest).toBeNull();

	const activeAfterClose = st.activeTabByWorkspace.ws1;
	const placedId = "legacy:chat:a";
	store.restorePlacedChatCache(asWorkspaceId("ws1"), placedId, asSessionId("a"), "Restored chat");
	st = useAppStore.getState();
	expect(st.tabsByWorkspace.ws1?.some((tab) => tab.id === placedId)).toBe(true);
	expect(st.closedChatsByWorkspace.ws1 ?? []).toHaveLength(0);
	expect(st.activeTabByWorkspace.ws1).toBe(activeAfterClose);
	store.restorePlacedChatCache(
		asWorkspaceId("ws1"),
		placedId,
		asSessionId("a"),
		"Peer-renamed chat",
	);
	st = useAppStore.getState();
	expect(st.tabsByWorkspace.ws1?.find((tab) => tab.id === placedId)?.name).toBe(
		"Peer-renamed chat",
	);
	store.closeChatToHistory(asSessionId("a"));
	expect(useAppStore.getState().closedChatsByWorkspace.ws1?.[0]?.title).toBe("Peer-renamed chat");

	store.reopenChat(asWorkspaceId("ws1"), asSessionId("a"));
	st = useAppStore.getState();
	expect(st.tabsByWorkspace.ws1?.some((t) => t.kind === "chat" && t.sessionId === "a")).toBe(true);
	expect(st.activeTabByWorkspace.ws1).toBe(chatTabId(asWorkspaceId("ws1"), asSessionId("a")));
	expect(st.closedChatsByWorkspace.ws1 ?? []).toHaveLength(0);
	expect(st.sessions.a?.isStreaming).toBe(true);
});

test("reopening a chat targets its captured workspace after the user switches away", () => {
	const store = useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws1") });
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("captured"), null, "medium");
	store.closeChatToHistory(asSessionId("captured"));
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws2") });
	store.reopenChat(asWorkspaceId("ws1"), asSessionId("captured"), { activate: false });
	const state = useAppStore.getState();
	expect(
		state.tabsByWorkspace.ws1?.some((tab) => tab.kind === "chat" && tab.sessionId === "captured"),
	).toBe(true);
	expect(state.tabsByWorkspace.ws2).toBeUndefined();
	expect(state.activeWorkspaceId).toBe(asWorkspaceId("ws2"));
});

test("deleteChat removes history/runtime state and falls back when deleting the active tab", () => {
	const store = useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws1") });
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("b"), null, "medium");

	store.closeChatToHistory(asSessionId("a"));
	store.deleteChat(asWorkspaceId("ws1"), asSessionId("a"));
	let st = useAppStore.getState();
	expect(st.closedChatsByWorkspace.ws1 ?? []).toHaveLength(0);
	expect(st.sessions.a).toBeUndefined();
	expect(st.skillsSyncedTickBySession.a).toBeUndefined();
	expect(st.sessions.b).toBeDefined();

	store.openChatSession(asWorkspaceId("ws1"), asSessionId("c"), null, "medium");
	const beforeNav = useAppStore.getState().navTickByWorkspace.ws1 ?? 0;
	store.deleteChat(asWorkspaceId("ws1"), asSessionId("c"));
	st = useAppStore.getState();
	expect(st.tabsByWorkspace.ws1?.some((t) => t.kind === "chat" && t.sessionId === "c")).toBe(false);
	expect(st.activeTabByWorkspace.ws1).toBe(chatTabId(asWorkspaceId("ws1"), asSessionId("b")));
	expect(st.navTickByWorkspace.ws1).toBe(beforeNav + 1);
	expect(st.sessions.c).toBeUndefined();
});

test("session-list reconciliation removes missed deletions without deleting a chat created mid-read", () => {
	const store = useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws1") });
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("stale"), null, "medium");
	const baseline = selectWorkspaceSessionIds(useAppStore.getState(), asWorkspaceId("ws1"));

	store.openChatSession(asWorkspaceId("ws1"), asSessionId("newcomer"), null, "medium");
	store.reconcileWorkspaceSessions(asWorkspaceId("ws1"), baseline, []);

	const state = useAppStore.getState();
	expect(state.sessions.stale).toBeUndefined();
	expect(state.deletedSessionsByWorkspace.ws1?.stale).toBe(true);
	expect(
		state.tabsByWorkspace.ws1?.some((tab) => tab.kind === "chat" && tab.sessionId === "stale"),
	).toBe(false);
	expect(state.sessions.newcomer).toBeDefined();
	expect(state.activeTabByWorkspace.ws1).toBe(
		chatTabId(asWorkspaceId("ws1"), asSessionId("newcomer")),
	);
});

test("authoritative session reconciliation never impersonates user navigation", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("missing"), null, "medium");
	const baseline = selectWorkspaceSessionIds(useAppStore.getState(), asWorkspaceId("ws1"));
	const before = useAppStore.getState().navTickByWorkspace.ws1 ?? 0;
	store.reconcileWorkspaceSessions(asWorkspaceId("ws1"), baseline, []);
	const state = useAppStore.getState();
	expect(state.activeTabByWorkspace.ws1).toBeNull();
	expect(state.navTickByWorkspace.ws1 ?? 0).toBe(before);
});

test("session deletion drops queued chat and live-plan opens before pruning placement", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("queued"), null, "medium");
	store.openDoc({
		kind: "plan",
		id: "queued-plan",
		workspaceId: asWorkspaceId("ws1"),
		name: "Queued plan",
		sessionId: asSessionId("queued"),
	});
	store.deleteChat(asWorkspaceId("ws1"), asSessionId("queued"), false);
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
		workspaceId: asWorkspaceId("ws1"),
		sessionId: asSessionId("queued"),
	});
});

test("a deletion that beats session.create prevents its late response from restoring the chat", () => {
	const store = useAppStore.getState();

	store.deleteChat(asWorkspaceId("ws1"), asSessionId("late"));
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("late"), null, "medium");
	store.openTab(
		{
			kind: "chat",
			id: "late-cache",
			workspaceId: asWorkspaceId("ws1"),
			name: "Late cache",
			sessionId: asSessionId("late"),
		},
		"keep",
		false,
	);
	store.openDoc({
		kind: "doc",
		id: "late-todo",
		workspaceId: asWorkspaceId("ws1"),
		name: "Late TODO",
		content: "# Late",
		docPath: "TODO.md",
		sourceId: "late",
	});
	store.requestChatLocation({
		workspaceId: asWorkspaceId("ws1"),
		projectId: asProjectId("p1"),
		sessionId: asSessionId("late"),
		messageIndex: 0,
		anchorText: "late",
	});
	store.requestHistoryOpen({
		workspaceId: asWorkspaceId("ws1"),
		sessionId: asSessionId("late"),
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
		sessionId: asSessionId("late"),
		workspaceId: asWorkspaceId("ws1"),
		title: "Deleted chat",
		model: null,
		thinkingLevel: "medium",
		isStreaming: false,
		messageCount: 1,
		updatedAt: 1,
		live: true,
	};

	store.deleteChat(asWorkspaceId("ws1"), asSessionId("late"));
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
		sessionId: asSessionId("late"),
		workspaceId: asWorkspaceId("ws1"),
		title: "Deleted chat",
		model: null,
		thinkingLevel: "medium",
		isStreaming: false,
		messageCount: 1,
		updatedAt: 1,
		live: true,
	};

	store.deleteChat(asWorkspaceId("ws1"), asSessionId("late"));
	store.clearWorkspaceTabs(asWorkspaceId("ws1"));
	store.hydrateSession(summary, emptyHydration());

	expect(useAppStore.getState().sessions.late).toBeUndefined();
});

test("a deletion that beats session.list prevents its late history row from returning", () => {
	const store = useAppStore.getState();

	store.deleteChat(asWorkspaceId("ws1"), asSessionId("late"));
	store.noteClosedChats(asWorkspaceId("ws1"), [
		{ sessionId: asSessionId("late"), title: "Deleted chat", closedAt: 1 },
	]);

	expect(useAppStore.getState().closedChatsByWorkspace.ws1 ?? []).toHaveLength(0);
});

test("hydrateSession rebuilds a runtime + tab on connect, and never clobbers a live one", () => {
	const store = useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws1") });
	const summary: SessionSummary = {
		sessionId: asSessionId("h1"),
		workspaceId: asWorkspaceId("ws1"),
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
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("sync"), null, "medium");
	store.setChatDraft(asSessionId("sync"), "keep my draft");
	store.appendUserMessage(asSessionId("sync"), "old summarized prompt");
	store.handlePiEvent(agentStart, asSessionId("sync"));
	store.handlePiEvent({ type: "compaction_start", reason: "overflow" }, asSessionId("sync"));
	store.handlePiEvent(
		{
			type: "compaction_end",
			reason: "overflow",
			result: { tokensBefore: 268_000, estimatedTokensAfter: 24_000 },
			aborted: false,
			willRetry: true,
		},
		asSessionId("sync"),
	);

	const before = rt(asSessionId("sync"));
	const liveCompaction = before.turns.findLast((turn) => turn.kind === "compaction");
	if (liveCompaction?.kind !== "compaction") throw new Error("live compaction missing");
	const summary: SessionSummary = {
		sessionId: asSessionId("sync"),
		workspaceId: asWorkspaceId("ws1"),
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
	const after = rt(asSessionId("sync"));
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
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("sync-race"), null, "medium");
	store.appendUserMessage(asSessionId("sync-race"), "keep this turn");
	const expectedRevision = rt(asSessionId("sync-race")).eventRevision;

	store.handlePiEvent({ type: "turn_start" } as PiEvent, asSessionId("sync-race"));
	const crossed = rt(asSessionId("sync-race"));
	expect(crossed.eventRevision).toBe(expectedRevision + 1);

	const applied = store.reconcileSession(
		{
			sessionId: asSessionId("sync-race"),
			workspaceId: asWorkspaceId("ws1"),
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
	expect(rt(asSessionId("sync-race")).turns).toHaveLength(1);
	expect(rt(asSessionId("sync-race")).syncedConnectionGeneration).not.toBe(3);
});

test("noteClosedChats surfaces disk-only sessions in history, skipping live/open/known ones", () => {
	const store = useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws1") });
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("live1"), null, "medium");

	store.noteClosedChats(asWorkspaceId("ws1"), [
		{ sessionId: asSessionId("disk1"), title: "Old chat", closedAt: 200 },
		{ sessionId: asSessionId("disk2"), title: "Older chat", closedAt: 100 },
		{ sessionId: asSessionId("live1"), title: "dup of open tab", closedAt: 300 },
	]);
	let history = useAppStore.getState().closedChatsByWorkspace.ws1 ?? [];
	expect(history.map((c) => c.sessionId)).toEqual([asSessionId("disk1"), asSessionId("disk2")]);

	store.noteClosedChats(asWorkspaceId("ws1"), [
		{ sessionId: asSessionId("disk1"), title: "Old chat", closedAt: 200 },
	]);
	history = useAppStore.getState().closedChatsByWorkspace.ws1 ?? [];
	expect(history).toHaveLength(2);
	store.noteClosedChats(asWorkspaceId("ws1"), [
		{ sessionId: asSessionId("disk1"), title: "Renamed chat", closedAt: 400 },
	]);
	history = useAppStore.getState().closedChatsByWorkspace.ws1 ?? [];
	expect(history.find((chat) => chat.sessionId === "disk1")).toEqual({
		sessionId: asSessionId("disk1"),
		title: "Renamed chat",
		closedAt: 200,
	});
	store.noteClosedChats(asWorkspaceId("ws1"), [
		{ sessionId: asSessionId("disk2"), title: "", firstPrompt: "the older prompt", closedAt: 100 },
	]);
	history = useAppStore.getState().closedChatsByWorkspace.ws1 ?? [];
	expect(history.find((chat) => chat.sessionId === "disk2")).toEqual({
		sessionId: asSessionId("disk2"),
		title: "",
		firstPrompt: "the older prompt",
		closedAt: 100,
	});
	store.noteClosedChats(asWorkspaceId("ws1"), [
		{ sessionId: asSessionId("disk2"), title: "", closedAt: 100 },
	]);
	expect(
		useAppStore.getState().closedChatsByWorkspace.ws1?.find((chat) => chat.sessionId === "disk2")
			?.firstPrompt,
	).toBe("the older prompt");

	store.openChatSession(asWorkspaceId("ws1"), asSessionId("disk1"), null, "medium");
	history = useAppStore.getState().closedChatsByWorkspace.ws1 ?? [];
	expect(history.map((chat) => chat.sessionId)).toEqual([asSessionId("disk2")]);
});

test("opening a chat never steals another resource's canonical cache id", () => {
	const collidingId = chatTabId(asWorkspaceId("ws1"), asSessionId("collision-session"));
	const file: FileTab = {
		kind: "file",
		id: collidingId,
		workspaceId: asWorkspaceId("ws1"),
		name: "collision.ts",
		path: "collision.ts",
		content: "kept",
	};
	useAppStore.setState({ tabsByWorkspace: { ws1: [file] }, layoutIntents: [] });
	useAppStore
		.getState()
		.openChatSession(asWorkspaceId("ws1"), asSessionId("collision-session"), null, "medium");
	const tabs = useAppStore.getState().tabsByWorkspace.ws1 ?? [];
	const openedChat = tabs.find((tab) => tab.kind === "chat");

	expect(tabs.find((tab) => tab.kind === "file")).toEqual(file);
	expect(openedChat?.sessionId).toBe(asSessionId("collision-session"));
	expect(openedChat?.id).not.toBe(file.id);
	expect(useAppStore.getState().layoutIntents.at(-1)).toMatchObject({
		kind: "open",
		tab: { id: openedChat?.id, sessionId: asSessionId("collision-session") },
	});
});

test("restoring a stable chat placement never steals another resource's cache id", () => {
	const file = fileTab(asWorkspaceId("ws1"), "stable-placement-id");
	useAppStore.setState({ tabsByWorkspace: { ws1: [file] } });
	useAppStore
		.getState()
		.restorePlacedChatCache(
			asWorkspaceId("ws1"),
			file.id,
			asSessionId("collision-session"),
			"Chat",
		);
	const tabs = useAppStore.getState().tabsByWorkspace.ws1 ?? [];
	const restoredFile = tabs.find((tab) => tab.kind === "file");
	const restoredChat = tabs.find((tab) => tab.kind === "chat");

	expect(restoredFile).toEqual(file);
	expect(restoredChat?.sessionId).toBe(asSessionId("collision-session"));
	expect(restoredChat?.id).not.toBe(file.id);
});

test("hydrateSession preserves the stable id of an already-restored shared placement", () => {
	const store = useAppStore.getState();
	const summary: SessionSummary = {
		sessionId: asSessionId("legacy-session"),
		workspaceId: asWorkspaceId("ws1"),
		title: "Restored",
		model: null,
		thinkingLevel: "medium",
		isStreaming: false,
		messageCount: 0,
		updatedAt: 1,
		live: true,
	};
	store.restorePlacedChatCache(
		asWorkspaceId("ws1"),
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
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws1") });
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("other"), null, "medium");
	store.noteClosedChats(asWorkspaceId("ws1"), [
		{ sessionId: asSessionId("disk1"), title: "Old", closedAt: 1 },
	]);

	const summary: SessionSummary = {
		sessionId: asSessionId("disk1"),
		workspaceId: asWorkspaceId("ws1"),
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
	expect(st.activeTabByWorkspace.ws1).toBe(chatTabId(asWorkspaceId("ws1"), asSessionId("disk1")));
});

test("clearWorkspaceTabs drops both open and closed chat runtimes + clears history", () => {
	const store = useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws1") });
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("b"), null, "medium");
	store.closeChatToHistory(asSessionId("a"));

	store.clearWorkspaceTabs(asWorkspaceId("ws1"));
	const st = useAppStore.getState();
	expect(st.sessions.a).toBeUndefined();
	expect(st.sessions.b).toBeUndefined();
	expect(st.closedChatsByWorkspace.ws1).toBeUndefined();
	expect(st.tabsByWorkspace.ws1).toBeUndefined();
});

test("requestChatLocation sets the jump deep link AND switches project+workspace atomically; clearChatLocation drops it", () => {
	const store = useAppStore.getState();
	useAppStore.setState({
		selectedProjectId: asProjectId("p1"),
		activeWorkspaceId: asWorkspaceId("ws1"),
	});

	store.requestChatLocation({
		workspaceId: asWorkspaceId("ws2"),
		projectId: asProjectId("p2"),
		sessionId: asSessionId("s1"),
		messageIndex: 3,
		anchorText: "deploy the docs",
	});
	let st = useAppStore.getState();
	expect(st.chatLocationRequest).toEqual({
		workspaceId: asWorkspaceId("ws2"),
		projectId: asProjectId("p2"),
		sessionId: asSessionId("s1"),
		messageIndex: 3,
		anchorText: "deploy the docs",
	});
	expect(st.activeWorkspaceId).toBe(asWorkspaceId("ws2"));
	expect(st.selectedProjectId).toBe(asProjectId("p2"));

	store.clearChatLocation();
	st = useAppStore.getState();
	expect(st.chatLocationRequest).toBeNull();
	expect(st.activeWorkspaceId).toBe(asWorkspaceId("ws2"));
	expect(st.selectedProjectId).toBe(asProjectId("p2"));
});

test("requestChatLocation captures an already-hydrated destination before switching workspaces", () => {
	useAppStore.setState({
		activeWorkspaceId: asWorkspaceId("ws1"),
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
		workspaceId: asWorkspaceId("ws2"),
		projectId: asProjectId("p2"),
		sessionId: asSessionId("session"),
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
		id: asProjectId("p1"),
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
		id: asProjectId("p2"),
		name: "Project two",
		path: "/projects/two",
		slug: "project-two",
		lastOpened: 200,
		closed: true,
	});
	const workspace = pushedWorkspace({ id: asWorkspaceId("w2"), projectId: asProjectId("p2") });
	const tabs = {
		w2: [
			{
				kind: "file",
				id: "w2:a",
				workspaceId: asWorkspaceId("w2"),
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
		selectedProjectId: asProjectId("p2"),
		activeWorkspaceId: asWorkspaceId("w2"),
		tabsByWorkspace: tabs,
	});

	useAppStore.getState().installProjectSnapshot([p1], [p1, p2]);

	const state = useAppStore.getState();
	expect(state.projects.map((candidate) => candidate.id)).toEqual([asProjectId("p1")]);
	expect(state.recentProjects.map((candidate) => candidate.id)).toEqual([
		asProjectId("p2"),
		asProjectId("p1"),
	]);
	expect(state.selectedProjectId).toBe(asProjectId("p1"));
	expect(state.activeWorkspaceId).toBeNull();
	expect(state.workspaces.p2).toEqual([workspace]);
	expect(state.tabsByWorkspace).toBe(tabs);
});

test("projects-rail expansion: gestures reveal, restore stays neutral, the chevron toggles", () => {
	const p1 = project();
	const p2 = project({
		id: asProjectId("p2"),
		name: "Project two",
		path: "/projects/two",
		slug: "project-two",
	});
	useAppStore.setState({ projects: [p1, p2], recentProjects: [p1, p2] });
	const store = useAppStore.getState();

	store.selectProject(asProjectId("p1"));
	expect(useAppStore.getState().expandedProjectIds).toEqual({});
	store.selectProject(asProjectId("p1"), { reveal: true });
	expect(useAppStore.getState().expandedProjectIds).toEqual({ p1: true });
	const before = useAppStore.getState().expandedProjectIds;
	store.expandProject(asProjectId("p1"));
	expect(useAppStore.getState().expandedProjectIds).toBe(before);
	store.toggleProjectExpanded(asProjectId("p1"));
	expect(useAppStore.getState().expandedProjectIds).toEqual({});
	store.toggleProjectExpanded(asProjectId("p2"));
	expect(useAppStore.getState().expandedProjectIds).toEqual({ p2: true });
	useAppStore.getState().applyProjectUpdated({ ...p2, closed: true });
	expect(useAppStore.getState().expandedProjectIds).toEqual({});
});

test("hydrateExpandedProjects seeds the persisted mirror; the welcome snapshot prunes to the open rail", () => {
	const p1 = project();
	useAppStore
		.getState()
		.hydrateExpandedProjects([asProjectId("p1"), asProjectId("stale-closed-project")]);
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
		id: asProjectId("p2"),
		name: "Project two",
		path: "/projects/two",
		slug: "project-two",
		lastOpened: 50,
	});
	useAppStore.setState({
		projects: [p1, p2],
		recentProjects: [p1, p2],
		workspaces: { p1: [pushedWorkspace()] },
		selectedProjectId: asProjectId("p1"),
		activeWorkspaceId: asWorkspaceId("w1"),
	});

	useAppStore.getState().applyProjectUpdated({ ...p2, closed: true });

	const state = useAppStore.getState();
	expect(state.projects.map((candidate) => candidate.id)).toEqual([asProjectId("p1")]);
	expect(state.recentProjects.find((candidate) => candidate.id === "p2")?.closed).toBe(true);
	expect(state.selectedProjectId).toBe(asProjectId("p1"));
	expect(state.activeWorkspaceId).toBe(asWorkspaceId("w1"));
});

test("applyProjectUpdated closes the current project to the next Home and preserves its view maps", () => {
	const p1 = project();
	const p2 = project({
		id: asProjectId("p2"),
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
				workspaceId: asWorkspaceId("w1"),
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
		selectedProjectId: asProjectId("p1"),
		activeWorkspaceId: asWorkspaceId("w1"),
		tabsByWorkspace: tabs,
	});

	useAppStore.getState().applyProjectUpdated({ ...p1, closed: true });

	const state = useAppStore.getState();
	expect(state.projects.map((candidate) => candidate.id)).toEqual([asProjectId("p2")]);
	expect(state.selectedProjectId).toBe(asProjectId("p2"));
	expect(state.activeWorkspaceId).toBeNull();
	expect(state.workspaces.p1).toEqual([workspace]);
	expect(state.tabsByWorkspace).toBe(tabs);
});

test("applyProjectUpdated reopens and reorders the same project without duplicating it", () => {
	const p1 = project();
	const closed = project({
		id: asProjectId("p2"),
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
		asProjectId("p2"),
		asProjectId("p1"),
	]);
	expect(state.recentProjects.map((candidate) => candidate.id)).toEqual([
		asProjectId("p2"),
		asProjectId("p1"),
	]);
	expect(state.projects.filter((candidate) => candidate.id === "p2")).toHaveLength(1);
	expect(state.recentProjects[0]?.closed).toBeUndefined();
});

test("applyProjectUpdated closes the last project to the no-project state", () => {
	const p1 = project();
	useAppStore.setState({
		projects: [p1],
		recentProjects: [p1],
		selectedProjectId: asProjectId("p1"),
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
		id: asWorkspaceId("w1"),
		projectId: asProjectId("p1"),
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
		selectedProjectId: asProjectId("p1"),
		activeWorkspaceId: asWorkspaceId("w1"),
	});
	const transitions: [string | null, string | null][] = [];
	const unsubscribe = useAppStore.subscribe((state) => {
		transitions.push([state.selectedProjectId, state.activeWorkspaceId]);
	});

	useAppStore.getState().selectProject(asProjectId("p2"));
	expect(transitions).toEqual([["p2", null]]);

	transitions.length = 0;
	useAppStore
		.getState()
		.activateWorkspace(pushedWorkspace({ id: asWorkspaceId("w3"), projectId: asProjectId("p3") }));
	expect(transitions).toEqual([["p3", "w3"]]);
	unsubscribe();
});

test("the selected chat of an entered workspace is attended once layout attention converges", () => {
	const workspace = pushedWorkspace();
	const sessionId = asSessionId("workspace-entry-chat");
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
	const sessionId = asSessionId("marked-unread-chat");
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
	const sessionId = asSessionId("entered-mid-mark");
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
	const w2 = pushedWorkspace({ id: asWorkspaceId("w2"), projectId: asProjectId("p2") });
	useAppStore.setState({
		projects: [project(), project({ id: asProjectId("p2") })],
		workspaces: { p1: [w1], p2: [w2] },
	});

	useAppStore.getState().activateWorkspace(w1);
	useAppStore.getState().activateWorkspace(w2);
	expect(useAppStore.getState().workspaceSelectionHistory).toEqual([
		asWorkspaceId("w2"),
		asWorkspaceId("w1"),
	]);

	useAppStore.getState().activateWorkspaceFromRoute(w1);
	expect(useAppStore.getState().workspaceSelectionHistory).toEqual([
		asWorkspaceId("w1"),
		asWorkspaceId("w2"),
	]);

	useAppStore.getState().requestChatLocation({
		workspaceId: asWorkspaceId("w2"),
		projectId: asProjectId("p2"),
		sessionId: asSessionId("session"),
		messageIndex: 0,
		anchorText: "target",
	});
	expect(useAppStore.getState().workspaceSelectionHistory).toEqual([
		asWorkspaceId("w2"),
		asWorkspaceId("w1"),
	]);

	useAppStore.getState().selectProject(asProjectId("p1"));
	expect(useAppStore.getState().workspaceSelectionHistory).toEqual([
		asWorkspaceId("w2"),
		asWorkspaceId("w1"),
	]);
});

test("installWelcomeSnapshot lands one complete snapshot and advances its own generation", () => {
	const p1 = project();
	const closed = project({
		id: asProjectId("p2"),
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
		expect(state.projects.map((candidate) => candidate.id)).toEqual([asProjectId("p1")]);
		expect(state.recentProjects.map((candidate) => candidate.id)).toEqual([
			asProjectId("p1"),
			asProjectId("p2"),
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
		projects: [project({ id: asProjectId("p2"), path: "/projects/two", slug: "two" })],
		selectedProjectId: asProjectId("p2"),
		activeWorkspaceId: null,
	});

	useAppStore.getState().installWelcomeSnapshot(44, [p1], [p1]);
	expect(useAppStore.getState().selectedProjectId).toBe(asProjectId("p1"));
});

test("activateWorkspaceFromRoute atomically stamps exact-chat intent", () => {
	const workspace = pushedWorkspace();
	useAppStore.setState({ workspaces: { p1: [workspace] }, navTickByWorkspace: { w1: 3 } });

	useAppStore.getState().activateWorkspaceFromRoute(workspace, asSessionId("s1"));
	expect(useAppStore.getState()).toMatchObject({
		selectedProjectId: asProjectId("p1"),
		activeWorkspaceId: asWorkspaceId("w1"),
		routeChatTarget: {
			workspaceId: asWorkspaceId("w1"),
			sessionId: asSessionId("s1"),
			navTick: 4,
			navigation: null,
			validated: false,
		},
		routeChatTargetGeneration: 1,
	});

	useAppStore.getState().activateWorkspaceFromRoute(workspace);
	expect(useAppStore.getState().routeChatTarget).toBeNull();
	expect(selectWorkspaceNavTick(useAppStore.getState(), asWorkspaceId("w1"))).toBe(5);
	expect(useAppStore.getState().routeChatTargetGeneration).toBe(1);
	const before = useAppStore.getState();
	useAppStore.getState().clearRouteChatTarget();
	expect(useAppStore.getState()).toBe(before);
});

test("closeChatToHistory keeps a route target for the closed session", () => {
	const workspace = pushedWorkspace();
	useAppStore.setState({ workspaces: { p1: [workspace] } });
	useAppStore.getState().openChatSession(asWorkspaceId("w1"), asSessionId("s1"), null, "medium");
	useAppStore.getState().activateWorkspaceFromRoute(workspace, asSessionId("s1"));
	const target = useAppStore.getState().routeChatTarget;
	expect(target?.sessionId).toBe(asSessionId("s1"));

	useAppStore.getState().closeChatToHistory(asSessionId("s1"), false, asWorkspaceId("w1"), false);
	expect(useAppStore.getState().closedChatsByWorkspace.w1?.[0]?.sessionId).toBe(asSessionId("s1"));
	expect(useAppStore.getState().routeChatTarget).toBe(target);
});

test("selectCurrentRouteChatTarget rejects overtaken or off-workspace intent", () => {
	const workspace = pushedWorkspace();
	useAppStore.setState({ workspaces: { p1: [workspace] } });
	useAppStore.getState().activateWorkspaceFromRoute(workspace, asSessionId("s1"));
	expect(selectCurrentRouteChatTarget(useAppStore.getState())?.sessionId).toBe(asSessionId("s1"));

	useAppStore.getState().noteNavigation(asWorkspaceId("w1"));
	expect(selectCurrentRouteChatTarget(useAppStore.getState())).toBeNull();

	useAppStore.getState().activateWorkspaceFromRoute(workspace, asSessionId("s1"));
	useAppStore.getState().selectProject(asProjectId("p1"));
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
		id: asWorkspaceId("other"),
		name: "workspace-2",
		branch: "workspace-2",
	});
	useAppStore.setState({ workspaces: { p1: [existing] } });
	useAppStore.getState().updateWorkspace(pushedWorkspace());

	const list = useAppStore.getState().workspaces.p1;
	expect(list).toHaveLength(1);
	expect(list?.[0]?.id).toBe(asWorkspaceId("other"));
});

test("removeWorkspace optimistically drops the row, leaving siblings; unknown project/id is a no-op", () => {
	const keep = pushedWorkspace({
		id: asWorkspaceId("other"),
		name: "workspace-2",
		branch: "workspace-2",
	});
	useAppStore.setState({ workspaces: { p1: [pushedWorkspace(), keep] } });

	useAppStore.getState().removeWorkspace(asProjectId("p1"), asWorkspaceId("w1"));
	expect(useAppStore.getState().workspaces.p1?.map((w) => w.id)).toEqual([asWorkspaceId("other")]);

	useAppStore.getState().removeWorkspace(asProjectId("p1"), asWorkspaceId("missing"));
	expect(useAppStore.getState().workspaces.p1).toHaveLength(1);
	useAppStore.getState().removeWorkspace(asProjectId("p2"), asWorkspaceId("w1"));
	expect(useAppStore.getState().workspaces.p2).toBeUndefined();
});

test("addWorkspace upserts into a fetched list (append if absent, merge if present)", () => {
	const other = pushedWorkspace({
		id: asWorkspaceId("other"),
		name: "workspace-2",
		branch: "workspace-2",
	});
	useAppStore.setState({ workspaces: { p1: [other] } });

	useAppStore.getState().addWorkspace(pushedWorkspace());
	expect(useAppStore.getState().workspaces.p1?.map((w) => w.id)).toEqual([
		asWorkspaceId("other"),
		asWorkspaceId("w1"),
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
		id: asWorkspaceId("w2"),
		projectId: asProjectId("p2"),
		name: "previous",
	});
	const previousSessionId = asSessionId("passive-fallback-chat");
	useAppStore.setState({
		projects: [project(), project({ id: asProjectId("p2") })],
		workspaces: { p1: [removed], p2: [previous] },
		selectedProjectId: asProjectId("p1"),
		activeWorkspaceId: asWorkspaceId("w1"),
		workspaceSelectionHistory: [asWorkspaceId("w1"), asWorkspaceId("w2")],
		sessionStateByWorkspace: {
			w2: {
				[previousSessionId]: {
					workspaceId: asWorkspaceId("w2"),
					projectId: asProjectId("p2"),
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

	useAppStore.getState().applyWorkspaceRemoved(asProjectId("p1"), asWorkspaceId("w1"));

	const state = useAppStore.getState();
	expect(state.activeWorkspaceId).toBe(asWorkspaceId("w2"));
	expect(state.selectedProjectId).toBe(asProjectId("p2"));
	expect(state.workspaceSelectionHistory).toEqual([asWorkspaceId("w2")]);
	expect(state.toasts).toHaveLength(1);
});

test("applyWorkspaceRemoved skips missing, tombstoned, and closed-project history entries", () => {
	const removed = pushedWorkspace();
	const tombstoned = pushedWorkspace({
		id: asWorkspaceId("tombstoned"),
		projectId: asProjectId("p3"),
	});
	const closed = pushedWorkspace({ id: asWorkspaceId("closed"), projectId: asProjectId("p2") });
	const valid = pushedWorkspace({ id: asWorkspaceId("valid"), projectId: asProjectId("p3") });
	useAppStore.setState({
		projects: [project(), project({ id: asProjectId("p3") })],
		workspaces: { p1: [removed], p2: [closed], p3: [tombstoned, valid] },
		removedWorkspaceIds: { tombstoned: true },
		selectedProjectId: asProjectId("p1"),
		activeWorkspaceId: asWorkspaceId("w1"),
		workspaceSelectionHistory: [
			asWorkspaceId("w1"),
			asWorkspaceId("missing"),
			asWorkspaceId("tombstoned"),
			asWorkspaceId("closed"),
			asWorkspaceId("valid"),
		],
	});

	useAppStore.getState().applyWorkspaceRemoved(asProjectId("p1"), asWorkspaceId("w1"));

	expect(useAppStore.getState().activeWorkspaceId).toBe(asWorkspaceId("valid"));
	expect(useAppStore.getState().selectedProjectId).toBe(asProjectId("p3"));
});

test("applyWorkspaceRemoved drops the row, clears its tabs, and returns the active client to Welcome + toast when history is empty", () => {
	useAppStore.setState({
		workspaces: { p1: [pushedWorkspace()] },
		selectedProjectId: asProjectId("stale-project"),
		activeWorkspaceId: asWorkspaceId("w1"),
		tabsByWorkspace: {
			w1: [
				{
					kind: "file",
					id: "w1:a",
					workspaceId: asWorkspaceId("w1"),
					name: "a",
					path: "a",
					content: "",
				},
			],
		},
		activeTabByWorkspace: { w1: "w1:a" },
		terminalsByWorkspace: {
			w1: [
				{ tabKey: "terminal-before-removal", workspaceId: asWorkspaceId("w1"), title: "Terminal" },
			],
		},
		changesRequest: { workspaceId: asWorkspaceId("w1"), path: "a", navTick: 0, navigation: null },
		specRequest: { workspaceId: asWorkspaceId("w1"), path: "SPEC.md", navigation: null },
		chatLocationRequest: {
			workspaceId: asWorkspaceId("w1"),
			projectId: asProjectId("p1"),
			sessionId: asSessionId("removed-chat"),
			messageIndex: 0,
			anchorText: "removed",
		},
		historyOpenRequest: { id: "history", sessionId: asSessionId("removed-chat") },
		reviewFocusRequest: {
			workspaceId: asWorkspaceId("w1"),
			commentId: "comment",
			surface: { kind: "diff", scope: { kind: "branch" } },
		},
		closedChatsByWorkspace: {
			w1: [{ sessionId: asSessionId("removed-chat"), title: "Removed", closedAt: 1 }],
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
		state.setWorkspaceTerminals(asWorkspaceId("w1"), [
			{ tabKey: "late-terminal", title: "Late terminal" },
		]);
	});

	useAppStore.getState().applyWorkspaceRemoved(asProjectId("p1"), asWorkspaceId("w1"));
	unsubscribe();

	const s = useAppStore.getState();
	expect(cleanupSubscriberAttempted).toBe(true);
	expect(s.workspaces.p1).toEqual([]);
	expect(s.tabsByWorkspace.w1).toBeUndefined();
	expect(s.activeWorkspaceId).toBeNull();
	expect(s.selectedProjectId).toBe(asProjectId("p1"));
	expect(s.toasts).toHaveLength(1);
	expect(s.toasts[0]?.message).toContain("add-login-flow");
	expect(s.changesRequest).toBeNull();
	expect(s.specRequest).toBeNull();
	expect(s.chatLocationRequest).toBeNull();
	expect(s.historyOpenRequest).toBeNull();
	expect(s.reviewFocusRequest).toBeNull();

	s.setLayoutAttention(asWorkspaceId("w1"), {
		selectedByGroup: {},
		lastFocusedCenterGroupId: "center",
		lastFocusedSideGroupId: {},
		navigationClockByGroup: { center: 0 },
	});
	s.openTab(
		{
			kind: "file",
			id: "late-file",
			workspaceId: asWorkspaceId("w1"),
			name: "late",
			path: "late",
			content: "",
		},
		"keep",
	);
	s.setWorkspaceTerminals(asWorkspaceId("w1"), [
		{ tabKey: "late-terminal", title: "Late terminal" },
	]);
	s.closeTerminalTab(asWorkspaceId("w1"), "late-terminal");
	s.setWorkspaceSpecs(asWorkspaceId("w1"), []);
	s.noteFsChanged({
		workspaceId: asWorkspaceId("w1"),
		paths: ["late"],
		truncated: false,
		skillChange: "none",
	});
	s.requestToolView(asWorkspaceId("w1"), "files");
	s.reconcileWorkspaceSessions(asWorkspaceId("w1"), [asSessionId("removed-chat")], []);
	s.noteClosedChats(asWorkspaceId("w1"), [
		{ sessionId: asSessionId("late-chat"), title: "Late", closedAt: 2 },
	]);
	s.requestChatLocation({
		workspaceId: asWorkspaceId("w1"),
		projectId: asProjectId("p1"),
		sessionId: asSessionId("late-chat"),
		messageIndex: 0,
		anchorText: "late",
	});
	s.activateWorkspace(pushedWorkspace());
	s.setWorkspaces(asProjectId("p1"), [pushedWorkspace()]);
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
		id: asWorkspaceId("other"),
		name: "workspace-2",
		branch: "workspace-2",
	});
	useAppStore.setState({
		workspaces: { p1: [pushedWorkspace(), keep] },
		activeWorkspaceId: asWorkspaceId("other"),
		workspaceSelectionHistory: [asWorkspaceId("other"), asWorkspaceId("w1")],
		toasts: [],
	});

	useAppStore.getState().applyWorkspaceRemoved(asProjectId("p1"), asWorkspaceId("w1"));

	const s = useAppStore.getState();
	expect(s.workspaces.p1?.map((w) => w.id)).toEqual([asWorkspaceId("other")]);
	expect(s.activeWorkspaceId).toBe(asWorkspaceId("other"));
	expect(s.workspaceSelectionHistory).toEqual([asWorkspaceId("other")]);
	expect(s.toasts).toHaveLength(0);
});

test("applyWorkspaceRemoved drops the removed workspace's cached spec graph", () => {
	const keep = pushedWorkspace({
		id: asWorkspaceId("other"),
		name: "workspace-2",
		branch: "workspace-2",
	});
	useAppStore.setState({
		workspaces: { p1: [pushedWorkspace(), keep] },
		activeWorkspaceId: asWorkspaceId("other"),
		specsByWorkspace: { w1: [], other: [] },
		toasts: [],
	});

	useAppStore.getState().applyWorkspaceRemoved(asProjectId("p1"), asWorkspaceId("w1"));

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
	const view = () => selectFilesTreeView(useAppStore.getState(), asWorkspaceId("w1"));
	const store = useAppStore.getState();

	store.setFilesTreeExpanded(asWorkspaceId("w1"), ["src", "src/auth"], true);
	const expanded = view().expanded;
	store.setFilesTreeExpanded(asWorkspaceId("w1"), ["src"], true);
	expect(view().expanded).toBe(expanded);
	store.setFilesTreeExpanded(asWorkspaceId("w1"), ["src/auth"], false);
	expect(view().expanded).toEqual(["src"]);
	store.collapseAllFiles(asWorkspaceId("w1"));
	expect(view().expanded).toEqual([]);

	store.setChangedTreeCollapsed(asWorkspaceId("w1"), ["apps/web"], true);
	store.setFilesTreeScroll(asWorkspaceId("w1"), "changedTree", 120, "branch");
	expect(view()).toMatchObject({
		changedCollapsed: ["apps/web"],
		scroll: { changedTree: { top: 120, scope: "branch" } },
	});
	expect(selectFilesTreeView(useAppStore.getState(), asWorkspaceId("w2")).expanded).toEqual([]);

	useAppStore.getState().applyWorkspaceRemoved(asProjectId("p1"), asWorkspaceId("w1"));
	expect(useAppStore.getState().filesTreeByWorkspace.w1).toBeUndefined();
	useAppStore.getState().setFilesTreeExpanded(asWorkspaceId("w1"), ["src"], true);
	expect(useAppStore.getState().filesTreeByWorkspace.w1).toBeUndefined();
});

test("revealInFiles expands every ancestor folder and records the revealed file", () => {
	useAppStore.setState({
		filesTreeByWorkspace: {},
		removedWorkspaceIds: nullProto<Record<string, true>>(),
	});
	useAppStore.getState().setFilesTreeExpanded(asWorkspaceId("w1"), ["docs"], true);
	useAppStore.getState().revealInFiles(asWorkspaceId("w1"), "src/auth/login.ts");
	const view = selectFilesTreeView(useAppStore.getState(), asWorkspaceId("w1"));
	expect(view.expanded).toEqual(["docs", "src", "src/auth"]);
	expect(view.seenActivePath).toBe("src/auth/login.ts");
	useAppStore.getState().revealInFiles(asWorkspaceId("w1"), "src/auth/login.ts");
	expect(selectFilesTreeView(useAppStore.getState(), asWorkspaceId("w1"))).toBe(view);
});

test("selectActiveFilePath follows the active file tab and ignores other tabs", () => {
	const file: FileTab = {
		kind: "file",
		id: "f",
		workspaceId: asWorkspaceId("w1"),
		name: "a",
		path: "./src/a.ts",
		content: "",
	};
	const tabsByWorkspace = { w1: [file] };
	expect(
		selectActiveFilePath(
			{ tabsByWorkspace, activeTabByWorkspace: { w1: "f" } },
			asWorkspaceId("w1"),
		),
	).toBe("src/a.ts");
	expect(
		selectActiveFilePath(
			{ tabsByWorkspace, activeTabByWorkspace: { w1: "chat" } },
			asWorkspaceId("w1"),
		),
	).toBeNull();
});

test("revealChanges and requestChangesView reveal Files in Changed mode", () => {
	useAppStore.setState({ filesMode: "all", layoutIntents: [] });
	useAppStore.getState().revealChanges(asWorkspaceId("w1"));
	expect(useAppStore.getState().filesMode).toBe("changed");
	expect(useAppStore.getState().layoutIntents).toMatchObject([
		{ kind: "reveal-tool", workspaceId: asWorkspaceId("w1"), tool: "files" },
	]);

	useAppStore.setState({ filesMode: "all", layoutIntents: [] });
	useAppStore.getState().requestChangesView(asWorkspaceId("w1"), null);
	expect(useAppStore.getState().filesMode).toBe("changed");
});

test("requestChangesView / requestSpecView pair independent path requests with reveal intents", () => {
	useAppStore.setState({ changesRequest: null, specRequest: null, layoutIntents: [] });

	useAppStore.getState().requestChangesView(asWorkspaceId("w1"), "src/a.ts");
	useAppStore.getState().requestSpecView(asWorkspaceId("w1"), ".thinkrail/context/TASK-x.md");

	const s = useAppStore.getState();
	expect(s.changesRequest).toEqual({
		workspaceId: asWorkspaceId("w1"),
		path: "src/a.ts",
		navTick: 1,
		navigation: null,
	});
	expect(s.specRequest).toEqual({
		workspaceId: asWorkspaceId("w1"),
		path: ".thinkrail/context/TASK-x.md",
		navigation: null,
	});
	expect(
		s.layoutIntents.map(({ kind, workspaceId, ...intent }) => ({ kind, workspaceId, ...intent })),
	).toMatchObject([
		{ kind: "reveal-tool", workspaceId: asWorkspaceId("w1"), tool: "files" },
		{ kind: "reveal-tool", workspaceId: asWorkspaceId("w1"), tool: "specs" },
	]);

	const first = useAppStore.getState().specRequest;
	useAppStore.getState().requestSpecView(asWorkspaceId("w1"), ".thinkrail/context/TASK-x.md");
	expect(useAppStore.getState().specRequest).not.toBe(first);
	expect(useAppStore.getState().specRequest).toEqual(first);
});

test("requestToolView reveals a tool without fabricating a path request", () => {
	useAppStore.setState({ layoutIntents: [], changesRequest: null, specRequest: null });

	useAppStore.getState().requestToolView(asWorkspaceId("w1"), "specs");

	const first = useAppStore.getState().layoutIntents[0];
	expect(first).toMatchObject({
		kind: "reveal-tool",
		workspaceId: asWorkspaceId("w1"),
		tool: "specs",
	});
	expect(useAppStore.getState().specRequest).toBeNull();
	expect(useAppStore.getState().changesRequest).toBeNull();

	useAppStore.getState().requestToolView(asWorkspaceId("w1"), "specs");
	const second = useAppStore.getState().layoutIntents[1];
	expect(second).toMatchObject({
		kind: "reveal-tool",
		workspaceId: asWorkspaceId("w1"),
		tool: "specs",
	});
	expect(second?.id).not.toBe(first?.id);
});

test("clearSpecRequest consumes the spec intent once — it opens a tab, so it must not replay", () => {
	useAppStore.setState({ specRequest: null, changesRequest: null });
	useAppStore.getState().requestSpecView(asWorkspaceId("w1"), "docs/SPEC.md");

	useAppStore.getState().clearSpecRequest();

	expect(useAppStore.getState().specRequest).toBeNull();
	useAppStore.getState().clearSpecRequest();
	expect(useAppStore.getState().specRequest).toBeNull();
	useAppStore.getState().requestChangesView(asWorkspaceId("w1"), "src/a.ts");
	useAppStore.getState().clearSpecRequest();
	expect(useAppStore.getState().changesRequest).toEqual({
		workspaceId: asWorkspaceId("w1"),
		path: "src/a.ts",
		navTick: 2,
		navigation: null,
	});
});

test("the Changes deep link stamps the nav count at the click, so a later navigation still wins", () => {
	useAppStore.setState({
		activeWorkspaceId: asWorkspaceId("ws1"),
		changesRequest: null,
		layoutIntents: [],
	});
	const s = () => useAppStore.getState();

	s().openTab(fileTab(asWorkspaceId("ws1"), "a.ts"), "keep");
	s().setActiveTab("ws1:a.ts");
	const beforeClick = selectWorkspaceNavTick(s(), asWorkspaceId("ws1"));

	s().requestChangesView(asWorkspaceId("ws1"), "src/b.ts");
	const request = s().changesRequest;
	if (!request) throw new Error("expected a changes request");
	expect(request.navTick).toBe(beforeClick + 1);

	expect(selectWorkspaceNavTick(s(), asWorkspaceId("ws1"))).toBe(request.navTick);

	s().setActiveTab("ws1:a.ts");
	expect(selectWorkspaceNavTick(s(), asWorkspaceId("ws1"))).not.toBe(request.navTick);
});

test("legacy selection reconciliation does not count as user navigation", () => {
	useAppStore.setState({
		tabsByWorkspace: {
			ws1: [fileTab(asWorkspaceId("ws1"), "a.ts"), fileTab(asWorkspaceId("ws1"), "b.ts")],
		},
		activeTabByWorkspace: { ws1: "ws1:a.ts" },
		navTickByWorkspace: { ws1: 7 },
	});
	useAppStore
		.getState()
		.syncLegacySelection(asWorkspaceId("ws1"), { kind: "editor", tabId: "ws1:b.ts" });
	expect(useAppStore.getState().activeTabByWorkspace.ws1).toBe("ws1:b.ts");
	expect(useAppStore.getState().activeTerminalByWorkspace.ws1).toBeNull();
	expect(useAppStore.getState().navTickByWorkspace.ws1).toBe(7);

	useAppStore.setState({
		terminalsByWorkspace: {
			ws1: [{ tabKey: "terminal", workspaceId: asWorkspaceId("ws1"), title: "Terminal" }],
		},
	});
	useAppStore.getState().syncLegacySelection(asWorkspaceId("ws1"), {
		kind: "terminal",
		tabKey: "terminal",
	});
	expect(useAppStore.getState().activeTabByWorkspace.ws1).toBeNull();
	expect(useAppStore.getState().activeTerminalByWorkspace.ws1).toBe("terminal");
	useAppStore.getState().syncLegacySelection(asWorkspaceId("ws1"), null);
	expect(useAppStore.getState().activeTabByWorkspace.ws1).toBeNull();
	expect(useAppStore.getState().activeTerminalByWorkspace.ws1).toBeNull();
	expect(useAppStore.getState().navTickByWorkspace.ws1).toBe(7);
});

test("deferred center navigation clocks are isolated by destination group", () => {
	useAppStore.setState({
		activeWorkspaceId: asWorkspaceId("ws1"),
		layoutAttentionByWorkspace: {
			ws1: {
				selectedByGroup: { a: "file-a", b: "file-b" },
				lastFocusedCenterGroupId: "a",
				lastFocusedSideGroupId: {},
				navigationClockByGroup: { a: 4, b: 9 },
			},
		},
	});

	const passive = captureCenterNavigation(useAppStore.getState(), asWorkspaceId("ws1"));
	expect(passive).toEqual({ groupId: "a", clock: 4 });
	const fromA = useAppStore.getState().beginCenterNavigation(asWorkspaceId("ws1"));
	expect(fromA).toEqual({ groupId: "a", clock: 5 });
	expect(isCenterNavigationCurrent(useAppStore.getState(), asWorkspaceId("ws1"), fromA)).toBe(true);
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws2") });
	expect(
		layoutOpenOptionsForNavigation(useAppStore.getState(), asWorkspaceId("ws1"), fromA),
	).toEqual({
		targetGroupId: "a",
		activate: false,
		navigation: fromA,
	});
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws1") });

	useAppStore.getState().beginCenterNavigation(asWorkspaceId("ws1"), "b");
	expect(isCenterNavigationCurrent(useAppStore.getState(), asWorkspaceId("ws1"), fromA)).toBe(true);
	expect(
		layoutOpenOptionsForNavigation(useAppStore.getState(), asWorkspaceId("ws1"), fromA),
	).toEqual({
		targetGroupId: "a",
		activate: false,
		navigation: fromA,
	});
	const withOtherGroupFocused = useAppStore.getState().layoutAttentionByWorkspace.ws1;
	if (!withOtherGroupFocused) throw new Error("missing attention fixture");
	expect(shouldAdvanceAcceptedNavigation(withOtherGroupFocused, fromA)).toBe(false);

	useAppStore.getState().beginCenterNavigation(asWorkspaceId("ws1"), "a");
	expect(isCenterNavigationCurrent(useAppStore.getState(), asWorkspaceId("ws1"), fromA)).toBe(
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
		layoutOpenOptionsForNavigation(useAppStore.getState(), asWorkspaceId("ws1"), fromA),
	).toEqual({
		targetGroupId: "a",
		navigation: fromA,
	});
	expect(shouldAdvanceAcceptedNavigation(onlyB, fromA)).toBe(true);
	const rerouted = useAppStore
		.getState()
		.beginCenterNavigation(asWorkspaceId("ws1"), "removed-group");
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
		activeWorkspaceId: asWorkspaceId("ws1"),
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
	const navigation = useAppStore.getState().beginCenterNavigation(asWorkspaceId("ws1"));
	const afterRequest = useAppStore.getState().navTickByWorkspace.ws1;
	useAppStore
		.getState()
		.openChatSession(
			asWorkspaceId("ws1"),
			asSessionId("session-requested"),
			null,
			"medium",
			undefined,
			layoutOpenOptionsForNavigation(useAppStore.getState(), asWorkspaceId("ws1"), navigation),
		);

	expect(useAppStore.getState().navTickByWorkspace.ws1).toBe(afterRequest);
	expect(useAppStore.getState().layoutIntents.at(-1)).toMatchObject({
		kind: "open",
		navigation,
	});
});

test("clearChangesRequest consumes the Changes intent once — it opens a diff tab, so it must not replay", () => {
	useAppStore.setState({ specRequest: null, changesRequest: null });
	useAppStore.getState().requestChangesView(asWorkspaceId("w1"), "src/a.ts");

	useAppStore.getState().clearChangesRequest();

	expect(useAppStore.getState().changesRequest).toBeNull();
	useAppStore.getState().requestSpecView(asWorkspaceId("w1"), "docs/SPEC.md");
	useAppStore.getState().clearChangesRequest();
	expect(useAppStore.getState().changesRequest).toBeNull();
	expect(useAppStore.getState().specRequest).toEqual({
		workspaceId: asWorkspaceId("w1"),
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

	useAppStore.getState().setWorkspaceSpecs(asWorkspaceId("w1"), [node]);

	const s = useAppStore.getState();
	expect(s.specsByWorkspace.w1).toEqual([node]);
	expect(s.specsByWorkspace.other).toEqual([]);
});

test("setWorkspaceSpecs keeps the previous array identity when the re-read found no change", () => {
	useAppStore.setState({ specsByWorkspace: {} });
	useAppStore.getState().setWorkspaceSpecs(asWorkspaceId("w1"), [specNode()]);
	const first = useAppStore.getState().specsByWorkspace.w1;

	useAppStore.getState().setWorkspaceSpecs(asWorkspaceId("w1"), [specNode()]);
	expect(useAppStore.getState().specsByWorkspace.w1).toBe(first);

	useAppStore.getState().setWorkspaceSpecs(asWorkspaceId("w1"), [specNode({ status: "active" })]);
	expect(useAppStore.getState().specsByWorkspace.w1).not.toBe(first);

	const withStatus = useAppStore.getState().specsByWorkspace.w1;
	useAppStore
		.getState()
		.setWorkspaceSpecs(asWorkspaceId("w1"), [specNode({ status: "active", tags: ["v1"] })]);
	expect(useAppStore.getState().specsByWorkspace.w1).not.toBe(withStatus);

	useAppStore.getState().setWorkspaceSpecs(asWorkspaceId("w1"), []);
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
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws1") });
	expect(s().changesView).toBe("tree");
	expect(s().changesLayout).toBe("stacked");
	const tab = {
		kind: "changes" as const,
		id: "ws1:changes:branch",
		workspaceId: asWorkspaceId("ws1"),
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

	s().setChangesTabViewed(asWorkspaceId("ws1"), tab.id, "src/a.ts", true);
	// the first piece of review progress keeps the tab: a later single-click preview must not evict it
	expect(s().previewTabByWorkspace.ws1).toBeUndefined();
	expect(s().layoutIntents.at(-1)).toMatchObject({
		kind: "select",
		tabId: tab.id,
		keep: true,
		focus: false,
	});
	s().setChangesTabViewed(asWorkspaceId("ws1"), tab.id, "src/a.ts", true);
	s().setChangesTabViewed(asWorkspaceId("ws1"), tab.id, "src/b.ts", true);
	s().setChangesTabViewed(asWorkspaceId("ws1"), tab.id, "src/b.ts", false);
	s().setChangesTabActivePath(asWorkspaceId("ws1"), tab.id, "src/a.ts");
	s().setChangesTabCollapsed(asWorkspaceId("ws1"), tab.id, { "bun.lock": false, "src/a.ts": true });
	s().setChangesTabCollapsed(asWorkspaceId("ws1"), tab.id, { "src/a.ts": null });
	s().requestChangesTabReveal(asWorkspaceId("ws1"), tab.id, "src/b.ts");
	s().requestChangesTabReveal(asWorkspaceId("ws1"), tab.id, "src/b.ts");
	s().setChangesTabSectionRenderer(asWorkspaceId("ws1"), tab.id, "README.md", "thinkrail/markdown");
	s().setChangesTabSectionViewState(asWorkspaceId("ws1"), tab.id, "README.md", { scrollTop: 7 });
	s().setChangesTabView(asWorkspaceId("ws1"), tab.id, "inline");
	s().setChangesTabIgnoreWhitespace(asWorkspaceId("ws1"), tab.id, true);
	s().setChangesTabHunkKept(asWorkspaceId("ws1"), tab.id, "src/a.ts", "h1", true, ["h1", "h2"]);
	s().setChangesTabHunkKept(asWorkspaceId("ws1"), tab.id, "src/a.ts", "h2", true, ["h1", "h2"]);
	s().setChangesTabHunkKept(asWorkspaceId("ws1"), tab.id, "src/a.ts", "h1", false, ["h1", "h2"]);
	s().setChangesTabHunkKept(asWorkspaceId("ws1"), tab.id, "src/a.ts", "h1", false, ["h1", "h2"]);

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
	s().setChangesTabSectionRenderer(asWorkspaceId("ws1"), tab.id, "README.md", "thinkrail/code");
	const switched = s().tabsByWorkspace.ws1?.[0];
	expect(switched?.kind === "changes" && switched.sections["README.md"]).toEqual({
		rendererId: "thinkrail/code",
	});
	expect(after.view).toBe("inline");
	expect(after.ignoreWhitespace).toBe(true);
	expect(after.kept).toEqual({ "src/a.ts": ["h2"] });

	s().consumeChangesTabReveal(asWorkspaceId("ws1"), tab.id, null);
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
	s().setChangesTabViewed(asWorkspaceId("ws2"), tab.id, "x", true);
	s().setChangesTabActivePath(asWorkspaceId("ws1"), "missing", "x");
	expect(s().tabsByWorkspace).toBe(before);
});

test("consuming a changes-tab reveal lands active path, expansion and focus in one write", () => {
	const s = () => useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws1") });
	const tab = {
		kind: "changes" as const,
		id: "ws1:changes:branch",
		workspaceId: asWorkspaceId("ws1"),
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
	s().requestChangesTabReveal(asWorkspaceId("ws1"), tab.id, "src/a.ts", "c1");
	let writes = 0;
	const unsubscribe = useAppStore.subscribe(() => {
		writes += 1;
	});
	s().consumeChangesTabReveal(asWorkspaceId("ws1"), tab.id, { path: "src/a.ts", commentId: "c1" });
	unsubscribe();
	expect(writes).toBe(1);
	const after = s().tabsByWorkspace.ws1?.[0];
	expect(after).toMatchObject({
		activePath: "src/a.ts",
		collapsed: { "src/a.ts": false },
		reveal: null,
	});
	expect(s().reviewFocusRequest).toEqual({
		workspaceId: asWorkspaceId("ws1"),
		commentId: "c1",
		surface: { kind: "diff", scope: { kind: "branch" } },
	});

	s().setChangesTabSectionViewState(asWorkspaceId("ws1"), tab.id, "src/a.ts", { scrollTop: 3 });
	const saved = s().tabsByWorkspace;
	s().setChangesTabSectionViewState(asWorkspaceId("ws1"), tab.id, "src/a.ts", { scrollTop: 3 });
	expect(s().tabsByWorkspace).toBe(saved);
});

test("diff tabs: openTab dedupes by id + activates; renderer, view state, and contents update in place", () => {
	const s = () => useAppStore.getState();
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws1") });
	const tab = {
		kind: "diff" as const,
		id: "ws1:diff:branch:src/a.ts",
		workspaceId: asWorkspaceId("ws1"),
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
	s().setTabViewState(asWorkspaceId("ws1"), tab.id, { scrollTop: 1 });
	s().setTabRenderer(asWorkspaceId("ws1"), tab.id, "thinkrail/code");
	expect(s().tabsByWorkspace.ws1?.[0]).not.toHaveProperty("viewState");
	s().setTabViewState(asWorkspaceId("ws1"), tab.id, { scrollTop: 42 });
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
		asWorkspaceId("ws1"),
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
					workspaceId: asWorkspaceId("ws1"),
					name: "one",
					path: "one",
					content: "one",
				},
			],
			ws2: [
				{
					kind: "file",
					id: "legacy-placement",
					workspaceId: asWorkspaceId("ws2"),
					name: "two",
					path: "two",
					content: "two",
				},
			],
		},
	});
	useAppStore
		.getState()
		.updateFileTabContent(asWorkspaceId("ws2"), "legacy-placement", "fresh", undefined, 4);
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws2") });
	useAppStore.getState().setTabRenderer(asWorkspaceId("ws2"), "legacy-placement", "thinkrail/code");
	useAppStore
		.getState()
		.setTabViewState(asWorkspaceId("ws2"), "legacy-placement", { scrollTop: 7 });
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
		activeWorkspaceId: asWorkspaceId("ws1"),
		tabsByWorkspace: {
			ws1: [fileTab(asWorkspaceId("ws1"), "one")],
			ws2: [fileTab(asWorkspaceId("ws2"), "two")],
		},
	});
	const { setTabRenderer, setTabViewState } = useAppStore.getState();

	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws2") });
	setTabRenderer(asWorkspaceId("ws1"), "shared-placement", "thinkrail/code");
	setTabViewState(asWorkspaceId("ws1"), "shared-placement", { scrollTop: 37 });

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
					id: asWorkspaceId("ws1"),
					projectId: asProjectId("p1"),
					name: "ws1",
					branch: "b",
					worktreePath: "/wt",
					baseBranch: "main",
				},
			],
		},
		activeWorkspaceId: asWorkspaceId("ws1"),
		selectedProjectId: asProjectId("p1"),
	});
	expect(selectDiffScope(s(), asWorkspaceId("ws1"))).toBe(
		selectDiffScope(s(), asWorkspaceId("ws2")),
	);
	expect(selectDiffScope(s(), asWorkspaceId("ws1"))).toEqual({ kind: "branch" });

	s().setDiffScope(asWorkspaceId("ws1"), { kind: "commit", sha: "abc123" });
	expect(selectDiffScope(s(), asWorkspaceId("ws1"))).toEqual({ kind: "commit", sha: "abc123" });
	expect(selectDiffScope(s(), asWorkspaceId("ws2"))).toEqual({ kind: "branch" });

	s().applyWorkspaceRemoved(asProjectId("p1"), asWorkspaceId("ws1"));
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
	s().openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	expect(isStale(asWorkspaceId("ws1"), asSessionId("a"))).toBe(false);

	s().noteFsChanged(skillFs(asWorkspaceId("ws1"), [".claude/skills/foo/SKILL.md"]));
	expect(isStale(asWorkspaceId("ws1"), asSessionId("a"))).toBe(true);

	expect(isStale(asWorkspaceId("ws1"), asSessionId("a"))).toBe(true);

	s().markSkillsSynced(asSessionId("a"), selectWorkspaceTick(s(), asWorkspaceId("ws1")));
	expect(isStale(asWorkspaceId("ws1"), asSessionId("a"))).toBe(false);

	s().noteFsChanged(skillFs(asWorkspaceId("ws1"), ["src/app.ts"], "none"));
	s().noteFsChanged(skillFs(asWorkspaceId("ws1"), ["README.md"], "none"));
	expect(isStale(asWorkspaceId("ws1"), asSessionId("a"))).toBe(false);
});

test("skills badge: the skill-change tick is accumulated, so a later non-skill batch can't lose it", () => {
	const s = () => useAppStore.getState();
	s().openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	s().noteFsChanged(skillFs(asWorkspaceId("ws1"), [".claude/skills/foo/SKILL.md"]));
	s().noteFsChanged(skillFs(asWorkspaceId("ws1"), ["src/app.ts"], "none"));
	expect(isStale(asWorkspaceId("ws1"), asSessionId("a"))).toBe(true);
});

test("skills badge: a pathless skill-neutral repo-metadata nudge refreshes without staling", () => {
	const s = () => useAppStore.getState();
	s().openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	s().noteFsChanged(skillFs(asWorkspaceId("ws1"), [], "none"));
	expect(selectWorkspaceTick(s(), asWorkspaceId("ws1"))).toBe(1);
	expect(isStale(asWorkspaceId("ws1"), asSessionId("a"))).toBe(false);
});

test("skills badge: generic path overflow is neutral, but detected and unknown skill impact flags", () => {
	const s = () => useAppStore.getState();
	s().openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	s().noteFsChanged(skillFs(asWorkspaceId("ws1"), ["dist/chunk.js"], "none", true));
	expect(selectWorkspaceTick(s(), asWorkspaceId("ws1"))).toBe(1);
	expect(isStale(asWorkspaceId("ws1"), asSessionId("a"))).toBe(false);

	s().noteFsChanged(skillFs(asWorkspaceId("ws1"), ["dist/chunk.js"], "detected", true));
	expect(isStale(asWorkspaceId("ws1"), asSessionId("a"))).toBe(true);
	s().markSkillsSynced(asSessionId("a"), selectWorkspaceTick(s(), asWorkspaceId("ws1")));

	s().noteFsChanged(skillFs(asWorkspaceId("ws1"), [], "unknown", true));
	expect(isStale(asWorkspaceId("ws1"), asSessionId("a"))).toBe(true);
});

test("skills badge: non-skill overflow during session creation does not open the new chat stale", () => {
	const s = () => useAppStore.getState();
	s().noteFsChanged(skillFs(asWorkspaceId("ws1"), [], "unknown", true));
	const baseline = selectWorkspaceTick(s(), asWorkspaceId("ws1"));
	s().noteFsChanged(skillFs(asWorkspaceId("ws1"), ["dist/chunk.js"], "none", true));
	s().openChatSession(asWorkspaceId("ws1"), asSessionId("new"), null, "medium", baseline);
	expect(isStale(asWorkspaceId("ws1"), asSessionId("new"))).toBe(false);
});

test("skills badge: per session — a chat opened after the change isn't flagged; reload clears only its own", () => {
	const s = () => useAppStore.getState();
	s().openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	s().noteFsChanged(skillFs(asWorkspaceId("ws1"), [".claude/skills/foo/SKILL.md"]));
	s().openChatSession(asWorkspaceId("ws1"), asSessionId("b"), null, "medium");
	expect(isStale(asWorkspaceId("ws1"), asSessionId("a"))).toBe(true);
	expect(isStale(asWorkspaceId("ws1"), asSessionId("b"))).toBe(false);

	s().noteFsChanged(skillFs(asWorkspaceId("ws1"), [".claude/skills/foo/SKILL.md"]));
	expect(isStale(asWorkspaceId("ws1"), asSessionId("a"))).toBe(true);
	expect(isStale(asWorkspaceId("ws1"), asSessionId("b"))).toBe(true);

	s().markSkillsSynced(asSessionId("b"), selectWorkspaceTick(s(), asWorkspaceId("ws1")));
	expect(isStale(asWorkspaceId("ws1"), asSessionId("a"))).toBe(true);
	expect(isStale(asWorkspaceId("ws1"), asSessionId("b"))).toBe(false);
});

test("skills badge: a skill change mid-reload stays flagged (baseline is captured at reload start)", () => {
	const s = () => useAppStore.getState();
	s().openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	const reloadBaseline = selectWorkspaceTick(s(), asWorkspaceId("ws1"));
	s().noteFsChanged(skillFs(asWorkspaceId("ws1"), [".claude/skills/foo/SKILL.md"]));
	s().markSkillsSynced(asSessionId("a"), reloadBaseline);
	expect(isStale(asWorkspaceId("ws1"), asSessionId("a"))).toBe(true);
});

test("skills badge: closing a chat runtime drops its sync baseline (no leak)", () => {
	const s = () => useAppStore.getState();
	s().openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");
	s().noteFsChanged(skillFs(asWorkspaceId("ws1"), [".claude/skills/foo/SKILL.md"]));
	s().markSkillsSynced(asSessionId("a"), selectWorkspaceTick(s(), asWorkspaceId("ws1")));
	expect(s().skillsSyncedTickBySession.a).toBeDefined();

	s().closeChatRuntime(asSessionId("a"));
	expect(s().skillsSyncedTickBySession.a).toBeUndefined();
});

test("skills badge: markSkillsSynced is monotonic and ignores a disposed session", () => {
	const s = () => useAppStore.getState();
	s().openChatSession(asWorkspaceId("ws1"), asSessionId("a"), null, "medium");

	s().markSkillsSynced(asSessionId("a"), 5);
	s().markSkillsSynced(asSessionId("a"), 2);
	expect(s().skillsSyncedTickBySession.a).toBe(5);

	s().closeChatRuntime(asSessionId("a"));
	s().markSkillsSynced(asSessionId("a"), 9);
	expect(s().skillsSyncedTickBySession.a).toBeUndefined();
});

const summaryFor = (sessionId: SessionId, live: boolean): SessionSummary => ({
	sessionId,
	workspaceId: asWorkspaceId("ws1"),
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
	s().noteFsChanged(skillFs(asWorkspaceId("ws1"), [".claude/skills/foo/SKILL.md"]));

	s().hydrateSession(summaryFor(asSessionId("live1"), true), emptyHydration());
	expect(isStale(asWorkspaceId("ws1"), asSessionId("live1"))).toBe(true);

	s().hydrateSession(
		summaryFor(asSessionId("disk1"), false),
		emptyHydration(),
		false,
		selectWorkspaceTick(s(), asWorkspaceId("ws1")),
	);
	expect(isStale(asWorkspaceId("ws1"), asSessionId("disk1"))).toBe(false);
});

test("explicitly passive hydration never becomes navigation just because the cache has no active tab", () => {
	const store = useAppStore.getState();
	store.hydrateSession(
		summaryFor(asSessionId("passive"), true),
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
	store.openTab(fileTab(asWorkspaceId("ws1"), "a.ts"), "keep");
	store.openTab(fileTab(asWorkspaceId("ws1"), "b.ts"), "preview");
	store.openTab(fileTab(asWorkspaceId("ws1"), "c.ts"), "keep");

	store.openTab(fileTab(asWorkspaceId("ws1"), "d.ts"), "preview");

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
	store.openTab(fileTab(asWorkspaceId("ws1"), "a.ts"), "preview");
	store.openTab(fileTab(asWorkspaceId("ws1"), "b.ts"), "preview");

	expect((useAppStore.getState().tabsByWorkspace.ws1 ?? []).map((tab) => tab.name)).toEqual([
		"a.ts",
		"b.ts",
	]);
});

test("a preview open of an already-kept tab focuses it without demoting it or moving the slot", () => {
	const store = useAppStore.getState();
	store.openTab(fileTab(asWorkspaceId("ws1"), "a.ts"), "keep");
	store.openTab(fileTab(asWorkspaceId("ws1"), "b.ts"), "preview");

	store.openTab(fileTab(asWorkspaceId("ws1"), "a.ts"), "preview");

	const s = useAppStore.getState();
	expect(s.activeTabByWorkspace.ws1).toBe("ws1:a.ts");
	expect(s.previewTabByWorkspace.ws1).toBe("ws1:b.ts");
	expect(s.tabsByWorkspace.ws1).toHaveLength(2);
});

test("keep releases the slot — through openTab, through setActiveTab, and through closeTab", () => {
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws1") });
	const store = useAppStore.getState();

	store.openTab(fileTab(asWorkspaceId("ws1"), "a.ts"), "preview");
	store.setActiveTab("ws1:a.ts", "keep");
	expect(useAppStore.getState().previewTabByWorkspace.ws1).toBeUndefined();

	store.openTab(fileTab(asWorkspaceId("ws1"), "b.ts"), "preview");
	store.openTab(fileTab(asWorkspaceId("ws1"), "b.ts"), "keep");
	expect(useAppStore.getState().previewTabByWorkspace.ws1).toBeUndefined();

	store.openTab(fileTab(asWorkspaceId("ws1"), "c.ts"), "preview");
	store.closeTab("ws1:c.ts");
	expect(useAppStore.getState().previewTabByWorkspace.ws1).toBeUndefined();
});

test("promotion is one-way: neither a plain activation nor a keep elsewhere demotes a tab", () => {
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws1") });
	const store = useAppStore.getState();
	store.openTab(fileTab(asWorkspaceId("ws1"), "a.ts"), "keep");
	store.openTab(fileTab(asWorkspaceId("ws1"), "b.ts"), "preview");

	store.setActiveTab("ws1:a.ts");
	expect(useAppStore.getState().previewTabByWorkspace.ws1).toBe("ws1:b.ts");

	store.setActiveTab("ws1:a.ts", "keep");
	expect(useAppStore.getState().previewTabByWorkspace.ws1).toBe("ws1:b.ts");
});

test("the slot is per workspace — clearWorkspaceTabs releases only its own", () => {
	const store = useAppStore.getState();
	store.openTab(fileTab(asWorkspaceId("ws1"), "a.ts"), "preview");
	store.openTab(fileTab(asWorkspaceId("ws2"), "b.ts"), "preview");

	store.clearWorkspaceTabs(asWorkspaceId("ws1"));

	const s = useAppStore.getState();
	expect(s.previewTabByWorkspace.ws1).toBeUndefined();
	expect(s.previewTabByWorkspace.ws2).toBe("ws2:b.ts");
});

test("chat, document, and plan tabs never enter the preview slot", () => {
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws1") });
	const store = useAppStore.getState();
	store.openTab(fileTab(asWorkspaceId("ws1"), "a.ts"), "preview");

	store.openChatSession(asWorkspaceId("ws1"), asSessionId("s1"), null, "medium");
	store.openDoc({
		kind: "doc",
		id: "ws1:plan",
		workspaceId: asWorkspaceId("ws1"),
		name: "Plan",
		content: "# plan",
		docPath: "plan.md",
		sourceId: "s1",
	});
	store.openTab(
		{
			kind: "chat",
			id: "direct-chat",
			workspaceId: asWorkspaceId("ws1"),
			name: "Direct chat",
			sessionId: asSessionId("s2"),
		},
		"preview",
	);
	store.openDoc({
		kind: "plan",
		id: "ws1:live-plan",
		workspaceId: asWorkspaceId("ws1"),
		name: "Live plan",
		sessionId: asSessionId("s3"),
	});

	const s = useAppStore.getState();
	expect(s.previewTabByWorkspace.ws1).toBe("ws1:a.ts");
	expect(s.tabsByWorkspace.ws1).toHaveLength(5);
	expect(s.layoutIntents.at(-1)).toMatchObject({ kind: "open", intent: "keep" });
});

test("a keep on an already-open tab releases ITS workspace's slot, never the active one's", () => {
	const store = useAppStore.getState();
	store.openTab(fileTab(asWorkspaceId("ws1"), "a.ts"), "preview");
	store.openTab(fileTab(asWorkspaceId("ws2"), "b.ts"), "preview");
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws2") });

	store.openTab(fileTab(asWorkspaceId("ws1"), "a.ts"), "keep");

	const s = useAppStore.getState();
	expect(s.previewTabByWorkspace.ws1).toBeUndefined();
	expect(s.previewTabByWorkspace.ws2).toBe("ws2:b.ts");
	expect(s.activeTabByWorkspace.ws1).toBe("ws1:a.ts");
	expect(s.activeTabByWorkspace.ws2).toBe("ws2:b.ts");
});

test("every center navigation bumps the workspace's nav tick, and none of them bypass it", () => {
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws1") });
	const tick = () => useAppStore.getState().navTickByWorkspace.ws1 ?? 0;
	const missed: string[] = [];
	const bumps = (label: string, act: () => void) => {
		const before = tick();
		act();
		if (tick() <= before) missed.push(label);
	};

	const s = () => useAppStore.getState();
	const beforeOpen = tick();
	s().openTab(fileTab(asWorkspaceId("ws1"), "a.ts"), "preview");
	s().openTab(fileTab(asWorkspaceId("ws1"), "a.ts"), "keep");
	expect(tick()).toBe(beforeOpen);

	bumps("setActiveTab", () => s().setActiveTab("ws1:a.ts"));
	bumps("openDoc", () =>
		s().openDoc({
			kind: "doc",
			id: "ws1:plan",
			workspaceId: asWorkspaceId("ws1"),
			name: "Plan",
			content: "# p",
			docPath: "plan.md",
			sourceId: "s1",
		}),
	);
	bumps("openChatSession", () =>
		s().openChatSession(asWorkspaceId("ws1"), asSessionId("sess"), null, "medium"),
	);
	bumps("closeChatToHistory", () => s().closeChatToHistory(asSessionId("sess")));
	bumps("reopenChat", () => s().reopenChat(asWorkspaceId("ws1"), asSessionId("sess")));
	s().setActiveTab("ws1:a.ts");
	bumps("closeTab", () => s().closeTab("ws1:a.ts"));
	bumps("noteNavigation", () => s().noteNavigation(asWorkspaceId("ws1")));
	bumps("requestHistoryOpen", () =>
		s().requestHistoryOpen({
			sessionId: asSessionId("sess"),
			workspaceId: asWorkspaceId("ws1"),
			tabId: "ws1:sess",
		}),
	);
	expect(s().layoutIntents.at(-1)).toMatchObject({ kind: "select", focus: false });
	expect(missed).toEqual([]);

	useAppStore.setState({ activeTabByWorkspace: { ws1: "ws1:sess" } });
	const before = tick();
	s().hydrateSession(
		{
			sessionId: asSessionId("bg"),
			workspaceId: asWorkspaceId("ws1"),
			title: "bg",
			createdAt: 0,
			updatedAt: 0,
			live: true,
		} as unknown as SessionSummary,
		emptyHydration(),
	);
	expect(tick()).toBe(before);

	expect(useAppStore.getState().navTickByWorkspace.ws2).toBeUndefined();
	s().clearWorkspaceTabs(asWorkspaceId("ws1"));
	expect(useAppStore.getState().navTickByWorkspace.ws1).toBeUndefined();
});

test("history selection resolves a cache alias to its stable shared placement id", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("history-alias"), null, "medium");
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
							sessionId: asSessionId("history-alias"),
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
		workspaceId: asWorkspaceId("ws1"),
		sessionId: asSessionId("history-alias"),
		tabId: cache.id,
	});
	expect(useAppStore.getState().layoutIntents.at(-1)).toMatchObject({
		kind: "select",
		tabId: "legacy-history-placement",
		resource: { kind: "chat", sessionId: asSessionId("history-alias") },
		focus: false,
	});
});

test("history selection never uses a colliding cache id as shared placement identity", () => {
	const store = useAppStore.getState();
	store.openChatSession(asWorkspaceId("ws1"), asSessionId("history-collision"), null, "medium");
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
		workspaceId: asWorkspaceId("ws1"),
		sessionId: asSessionId("history-collision"),
		tabId: collidingId,
	});
	const state = useAppStore.getState();
	expect(state.layoutIntents.at(-1)).toMatchObject({
		kind: "select",
		resource: { kind: "chat", sessionId: asSessionId("history-collision") },
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
	store.openTab(fileTab(asWorkspaceId("ws1"), "a.ts"), "keep");
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws2") });
	store.closeTab("ws1:a.ts", false, false, asWorkspaceId("ws1"));
	expect(useAppStore.getState().tabsByWorkspace.ws1).toEqual([]);
	expect(useAppStore.getState().tabsByWorkspace.ws2).toBeUndefined();
});

test("a close that moves no focus is not a navigation — it can't discard a browse in flight", () => {
	useAppStore.setState({ activeWorkspaceId: asWorkspaceId("ws1") });
	const s = () => useAppStore.getState();
	const tick = () => s().navTickByWorkspace.ws1 ?? 0;

	s().openTab(fileTab(asWorkspaceId("ws1"), "a.ts"), "keep");
	s().openTab(fileTab(asWorkspaceId("ws1"), "b.ts"), "keep");
	s().openChatSession(asWorkspaceId("ws1"), asSessionId("sess"), null, "medium");
	s().setActiveTab("ws1:b.ts");
	const before = tick();

	s().closeTab("ws1:a.ts");
	expect(tick()).toBe(before);
	expect(s().activeTabByWorkspace.ws1).toBe("ws1:b.ts");

	s().closeChatToHistory(asSessionId("sess"));
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
	useAppStore.getState().addTerminal(asWorkspaceId("w1"), undefined, "center-b");
	const state = useAppStore.getState();
	expect(state.terminalsByWorkspace.w1).toHaveLength(1);
	expect(state.layoutIntents).toHaveLength(1);
	expect(state.layoutIntents[0]).toMatchObject({
		kind: "place-terminal",
		workspaceId: asWorkspaceId("w1"),
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
	useAppStore.getState().addTerminal(asWorkspaceId("w1"), undefined, "bottom-b", "bottom");
	const state = useAppStore.getState();
	expect(state.layoutIntents[0]).toMatchObject({
		kind: "place-terminal",
		workspaceId: asWorkspaceId("w1"),
		targetGroupId: "bottom-b",
		targetArea: "bottom",
	});
	expect(state.layoutAttentionByWorkspace.w1).toBe(attention);
	expect(state.navTickByWorkspace.w1).toBeUndefined();
});

test("the host catalog confirms a reservation while retaining its one-shot command", () => {
	useAppStore.getState().addTerminal(asWorkspaceId("w1"), "code .", "bottom-a", "bottom");
	const pending = useAppStore.getState().terminalsByWorkspace.w1?.[0];
	if (!pending) throw new Error("missing pending terminal");
	expect(pending.reservationPending).toBe(true);

	useAppStore
		.getState()
		.setWorkspaceTerminals(asWorkspaceId("w1"), [{ tabKey: pending.tabKey, title: "Host title" }]);
	expect(useAppStore.getState().terminalsByWorkspace.w1).toEqual([
		{
			tabKey: pending.tabKey,
			workspaceId: asWorkspaceId("w1"),
			title: "Host title",
			initialCommand: "code .",
		},
	]);
	expect(useAppStore.getState().layoutIntents).toHaveLength(1);
});

test("hidden terminal seeding stays non-activating, idempotent, and atomically rejectable", () => {
	useAppStore
		.getState()
		.addTerminal(asWorkspaceId("w1"), undefined, "bottom-a", "bottom", false, "initial-terminal");
	useAppStore
		.getState()
		.addTerminal(asWorkspaceId("w1"), undefined, "bottom-a", "bottom", false, "initial-terminal");
	const pending = useAppStore.getState().terminalsByWorkspace.w1?.[0];
	if (!pending) throw new Error("missing pending terminal");
	expect(useAppStore.getState().terminalsByWorkspace.w1).toHaveLength(1);
	expect(useAppStore.getState().layoutIntents).toHaveLength(1);
	expect(useAppStore.getState().layoutIntents[0]).toMatchObject({
		kind: "place-terminal",
		workspaceId: asWorkspaceId("w1"),
		tabKey: pending.tabKey,
		targetGroupId: "bottom-a",
		targetArea: "bottom",
		reveal: false,
	});

	useAppStore.getState().rejectTerminalReservation(asWorkspaceId("w1"), pending.tabKey);
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
