import { describe, expect, test } from "bun:test";
import { testSessionId } from "@thinkrail/contracts/test-ids";
import {
	DEFAULT_CONFIG,
	isSettleIdleDays,
	isSubagentMaxConcurrent,
	RECENT_MODELS_LIMIT,
	type ReviewFixDetails,
	SETTLE_IDLE_DAYS,
	SUBAGENT_MAX_CONCURRENT,
} from "./domain";
import {
	CUSTOM_ENDPOINT_ID_PREFIX,
	completionDelivery,
	customMessageText,
	isBackgroundCommandCompletionMessage,
	isCustomEndpointId,
	isTodoReviewFixMessage,
	isToolResponsePending,
	normalizeSessionTitle,
	readToolResponseMessage,
	SESSION_TITLE_MAX_LENGTH,
	TODO_REVIEW_FIX_CUSTOM_TYPE,
	TOOL_RESPONSE_CUSTOM_TYPE,
	WS_CHANNELS,
	WS_METHODS,
} from "./wsProtocol";

test("retired workspace activity keeps only its empty snapshot compatibility method", () => {
	expect(WS_METHODS.sessionActivityList).toBe("session.activityList");
	expect(Object.hasOwn(WS_CHANNELS, "sessionActivity")).toBe(false);
});

test("subagent settings advance the protocol and name the workspace override mutation", () => {
	expect(WS_METHODS.workspaceSetSubagentsOverride).toBe("workspace.setSubagentsOverride");
});

test("JetBrains quota advances the protocol and names its read", () => {
	expect(WS_METHODS.providerJbcentralQuota).toBe("provider.jbcentralQuota");
});

test("host update execution advances the additive lifecycle protocol", () => {
	expect(WS_CHANNELS.hostUpdateAvailable).toBe("host.updateAvailable");
	expect(WS_METHODS.hostUpdate).toBe("host.update");
});

test("session rename is versioned and bounded", () => {
	expect(SESSION_TITLE_MAX_LENGTH).toBe(80);
	expect(WS_METHODS.sessionRename).toBe("session.rename");
});

test("normalized session state advances the protocol and names one snapshot/push channel", () => {
	expect(WS_METHODS.sessionStateList).toBe("session.stateList");
	expect(WS_METHODS.sessionAcknowledgeCompletion).toBe("session.acknowledgeCompletion");
	expect(WS_METHODS.sessionNudge).toBe("session.nudge");
	expect(WS_CHANNELS.sessionState).toBe("session.state");
});

test("session titles normalize to one bounded non-blank line", () => {
	expect(normalizeSessionTitle("  Fix auth\r\nredirect  ")).toBe("Fix auth redirect");
	expect(normalizeSessionTitle(" \n ")).toBeNull();
	expect(normalizeSessionTitle(null)).toBeNull();
	expect(normalizeSessionTitle(42)).toBeNull();
	expect(normalizeSessionTitle("x".repeat(80))).toBe("x".repeat(80));
	expect(normalizeSessionTitle("x".repeat(81))).toBeNull();
});

test("the plan-review subagent reshapes the review wire and advances the protocol", () => {
	expect(WS_CHANNELS.reviewChanged).toBe("review.changed");
	expect(WS_CHANNELS.reviewFailed).toBe("review.failed");
});

test("auto plan-summary generation advances the protocol to v69", () => {
	expect(WS_METHODS.todoGenerateSummary).toBe("todo.generateSummary");
});

test("host-owned new-chat defaults are pinned to v72", () => {
	expect(WS_METHODS.modelDefault).toBe("model.default");
	expect(WS_METHODS).not.toHaveProperty("modelSetDefault");
});

test("per-turn change sets, the turn diff scope and the turn.changed push are pinned to v80", () => {
	expect(WS_METHODS.workspaceTurns).toBe("workspace.turns");
	expect(WS_CHANNELS.turnChanged).toBe("turn.changed");
});

test("the subagent concurrency limit is pinned to v79", () => {
	expect(WS_METHODS.workspaceSetSubagentMaxConcurrent).toBe("workspace.setSubagentMaxConcurrent");
	expect(DEFAULT_CONFIG.subagentMaxConcurrent).toBe(SUBAGENT_MAX_CONCURRENT.default);
	expect(SUBAGENT_MAX_CONCURRENT).toEqual({ min: 1, max: 16, default: 4 });
	expect(isSubagentMaxConcurrent(1)).toBe(true);
	expect(isSubagentMaxConcurrent(16)).toBe(true);
	expect(isSubagentMaxConcurrent(0)).toBe(false);
	expect(isSubagentMaxConcurrent(17)).toBe(false);
	expect(isSubagentMaxConcurrent(2.5)).toBe(false);
	expect(isSubagentMaxConcurrent("4")).toBe(false);
});

test("the settled workspace shelf is pinned to v78", () => {
	expect(WS_METHODS.workspaceSettle).toBe("workspace.settle");
	expect(WS_METHODS.workspaceUnsettle).toBe("workspace.unsettle");
	expect(DEFAULT_CONFIG.settleIdleDays).toBe(SETTLE_IDLE_DAYS.default);
	expect(isSettleIdleDays(null)).toBe(true);
	expect(isSettleIdleDays(3)).toBe(true);
	expect(isSettleIdleDays(0)).toBe(false);
	expect(isSettleIdleDays(2.5)).toBe(false);
	expect(isSettleIdleDays("3")).toBe(false);
});

test("picker metadata and host-kept favorites/recents are pinned to v77", () => {
	expect(DEFAULT_CONFIG.favoriteModels).toEqual([]);
	expect(DEFAULT_CONFIG.recentModels).toEqual([]);
	expect(RECENT_MODELS_LIMIT).toBe(5);
});

test("the extension catalog and its on/off setting are pinned to v82", () => {
	expect(WS_METHODS.extensionList).toBe("extension.list");
	expect(DEFAULT_CONFIG.disabledExtensions).toEqual([]);
});

test("the project trust summary and pi-level resource consent are pinned to v81", () => {
	expect(WS_METHODS.projectTrustSummary).toBe("project.trustSummary");
});

test("workspace read state is pinned to v86", () => {
	expect(WS_METHODS.workspaceMarkUnread).toBe("workspace.markUnread");
	expect(WS_METHODS.workspaceMarkRead).toBe("workspace.markRead");
});

test("local language files and the locale setting are pinned to v89", () => {
	expect(WS_METHODS.localesList).toBe("locales.list");
	expect(WS_METHODS.localesReveal).toBe("locales.reveal");
	expect(WS_CHANNELS.localesChanged).toBe("locales.changed");
});

test("tool responses replace the ask-only answer method at v93", () => {
	expect(WS_METHODS.sessionRespondToTool).toBe("session.respondToTool");
	expect(WS_METHODS.sessionAnswerQuestion).toBe("session.answerQuestion");
});

test("voice input is pinned to v107", () => {
	expect(WS_METHODS.speechInstall).toBe("speech.install");
	expect(WS_METHODS.speechCancelInstall).toBe("speech.cancelInstall");
	expect(WS_METHODS.speechRemove).toBe("speech.remove");
	expect(WS_CHANNELS.speechChanged).toBe("speech.changed");
});

test("user-selectable fonts are pinned to v102", () => {
	expect(WS_METHODS.fontsList).toBe("fonts.list");
	expect(WS_METHODS.fontsInstalled).toBe("fonts.installed");
	expect(WS_METHODS.fontsReveal).toBe("fonts.reveal");
	expect(WS_CHANNELS.fontsChanged).toBe("fonts.changed");
});

test("background workspace creation is pinned to v104", () => {
	expect(WS_METHODS.workspaceStartCreate).toBe("workspace.startCreate");
	expect(WS_METHODS.workspaceListCreations).toBe("workspace.listCreations");
	expect(WS_METHODS.workspaceRetryCreation).toBe("workspace.retryCreation");
	expect(WS_METHODS.workspaceDismissCreation).toBe("workspace.dismissCreation");
	expect(WS_CHANNELS.workspaceCreationChanged).toBe("workspace.creationChanged");
	expect(WS_CHANNELS.workspaceCreationRemoved).toBe("workspace.creationRemoved");
});

test("user theme files are pinned to v92", () => {
	expect(WS_METHODS.themesList).toBe("themes.list");
	expect(WS_METHODS.themesReveal).toBe("themes.reveal");
	expect(WS_CHANNELS.themesChanged).toBe("themes.changed");
});

test("the stored host environment is pinned to v91", () => {
	expect(WS_METHODS.environmentGet).toBe("environment.get");
	expect(WS_METHODS.environmentUpdate).toBe("environment.update");
});

test("client error reports are pinned to v90", () => {
	expect(WS_METHODS.clientReportError).toBe("client.reportError");
});

test("host search and its previews are pinned to v106", () => {
	expect(WS_METHODS.searchQuery).toBe("search.query");
	expect(WS_METHODS.searchPreview).toBe("search.preview");
});

test("project rename is pinned to v85", () => {
	expect(WS_METHODS.projectRename).toBe("project.rename");
});

test("branch status, review-free push, and PR description sources are pinned to v87", () => {
	expect(WS_METHODS.workspaceBranchStatus).toBe("workspace.branchStatus");
	expect(WS_METHODS.workspacePush).toBe("workspace.push");
	expect(WS_METHODS.prGenerate).toBe("pr.generate");
	expect(WS_METHODS.workspaceOpenReview).toBe("workspace.openReview");
});

test("review details and the GitHub review actions are pinned to v88", () => {
	expect(WS_METHODS.prReady).toBe("pr.ready");
	expect(WS_METHODS.prMerge).toBe("pr.merge");
	expect(WS_METHODS.prReopen).toBe("pr.reopen");
	expect(WS_METHODS.workspaceDeleteRemoteBranch).toBe("workspace.deleteRemoteBranch");
});

test("pi package management and the package switch are pinned to v100", () => {
	expect(WS_METHODS.packagesList).toBe("packages.list");
	expect(WS_METHODS.packagesInstall).toBe("packages.install");
	expect(WS_METHODS.packagesRemove).toBe("packages.remove");
	expect(WS_METHODS.packagesUpdate).toBe("packages.update");
	expect(WS_METHODS.packagesCheckUpdates).toBe("packages.checkUpdates");
	expect(WS_METHODS.packagesSetResourceEnabled).toBe("packages.setResourceEnabled");
	expect(WS_METHODS.packagesReveal).toBe("packages.reveal");
	expect(WS_CHANNELS.packagesChanged).toBe("packages.changed");
	expect(DEFAULT_CONFIG.disabledPackages).toEqual([]);
});

test("project create and the onboarding dismissal are pinned to v94", () => {
	expect(WS_METHODS.projectCreate).toBe("project.create");
	expect(WS_METHODS.providerDetect).toBe("provider.detect");
	expect(DEFAULT_CONFIG.onboardingDismissed).toBe(false);
});

test("the GitHub star ask is pinned to v103", () => {
	expect(WS_CHANNELS.feedbackGithubStar).toBe("feedback.githubStar");
});

test("in-app surveys are pinned to v97", () => {
	expect(WS_METHODS.feedbackSurvey).toBe("feedback.survey");
	expect(WS_METHODS.feedbackSurveySubmit).toBe("feedback.survey.submit");
});

test("repository cloning and cancellation are registered", () => {
	expect(WS_METHODS.projectClone).toBe("project.clone");
	expect(WS_METHODS.projectCancelClone).toBe("project.cancelClone");
	expect(WS_METHODS.projectCloneDestination).toBe("project.cloneDestination");
});

test("MCP server management, status and chat resources are pinned to v83", () => {
	expect(WS_METHODS.mcpList).toBe("mcp.list");
	expect(WS_METHODS.mcpSetSessionOverride).toBe("mcp.setSessionOverride");
	expect(WS_METHODS.mcpLogin).toBe("mcp.login");
	expect(WS_METHODS.mcpReadOutput).toBe("mcp.readOutput");
	expect(WS_METHODS.mcpReadLog).toBe("mcp.readLog");
	expect(WS_CHANNELS.mcpStatus).toBe("mcp.status");
	expect(WS_METHODS).not.toHaveProperty("mcpStop");
});

test("always-allowed MCP tools and their revoke are pinned to v84", () => {
	expect(WS_METHODS.mcpRevokeToolGrant).toBe("mcp.revokeToolGrant");
});

test("rich review anchors advance the additive selector union to v74", () => {
	expect(WS_METHODS.reviewCommentAdd).toBe("review.commentAdd");
});

test("change mutations name their two methods at v75", () => {
	expect(WS_METHODS.changeRevert).toBe("change.revert");
	expect(WS_METHODS.changeUndo).toBe("change.undo");
});

test("model context settings name their two methods at v76", () => {
	expect(WS_METHODS.modelContextSettings).toBe("model.contextSettings");
	expect(WS_METHODS.modelSetContextWindow).toBe("model.setContextWindow");
});

test("resource metadata rides the two content reads from v75", () => {
	expect(WS_METHODS.fsReadFile).toBe("fs.readFile");
	expect(WS_METHODS.gitDiffFile).toBe("git.diffFile");
});

describe("isTodoReviewFixMessage", () => {
	const details: ReviewFixDetails = {
		itemId: "t_1",
		itemTitle: "Fix login redirect",
		reviewId: "r_1",
		note: "See the two findings below.",
		comments: [{ id: "c_1", kind: "inline", body: "off-by-one", path: "src/a.ts", startLine: 4 }],
	};
	const message = {
		role: "custom",
		customType: TODO_REVIEW_FIX_CUSTOM_TYPE,
		content: "Address each review comment above.",
		display: true,
		details,
		timestamp: 0,
	};

	test("accepts a well-formed todo-review-fix message", () => {
		expect(isTodoReviewFixMessage(message)).toBe(true);
	});

	test("rejects other custom types, roles, and malformed details", () => {
		expect(isTodoReviewFixMessage({ ...message, customType: "subagent-completion" })).toBe(false);
		expect(isTodoReviewFixMessage({ ...message, role: "user" })).toBe(false);
		expect(isTodoReviewFixMessage({ ...message, details: { itemId: "t_1" } })).toBe(false);
		expect(isTodoReviewFixMessage({ ...message, details: undefined })).toBe(false);
		expect(isTodoReviewFixMessage(null)).toBe(false);
		expect(isTodoReviewFixMessage("nope")).toBe(false);
	});

	test("comments may be empty (a note-only fix request)", () => {
		expect(isTodoReviewFixMessage({ ...message, details: { ...details, comments: [] } })).toBe(
			true,
		);
	});
});

describe("customMessageText", () => {
	test("returns a string content verbatim", () => {
		expect(customMessageText("hello")).toBe("hello");
	});

	test("joins text blocks and drops non-text content", () => {
		expect(
			customMessageText([
				{ type: "text", text: "a" },
				{ type: "image", data: "x", mimeType: "image/png" },
				{ type: "text", text: "b" },
			]),
		).toBe("ab");
	});
});

test("command completion guards accept displayed terminal notices, not malformed or hidden details", () => {
	const details = {
		id: "command",
		sessionId: testSessionId("parent"),
		name: "build",
		status: "completed",
		startedAt: 1,
		finishedAt: 2,
		exitCode: 0,
		output: { text: "<script>plain output</script>", truncated: false },
	};
	const message = {
		role: "custom",
		customType: "background-command-completion",
		display: true,
		content: "Finished",
		details,
	};
	expect(isBackgroundCommandCompletionMessage(message)).toBe(true);
	for (const status of ["stopped", "error"]) {
		expect(
			isBackgroundCommandCompletionMessage({
				...message,
				details: { ...details, status, exitCode: null, errorMessage: "diagnostic" },
			}),
		).toBe(true);
	}
	for (const invalid of [
		{ ...message, display: false },
		{ ...message, customType: "unrelated" },
		{ ...message, details: { ...details, status: "running" } },
		{ ...message, details: { ...details, finishedAt: undefined } },
		{ ...message, details: { ...details, startedAt: Number.NaN } },
		{ ...message, details: { ...details, name: {} } },
		{ ...message, details: { ...details, exitCode: "0" } },
		{ ...message, details: { ...details, errorMessage: [] } },
		{ ...message, details: { ...details, output: { text: "log", truncated: "false" } } },
		{ ...message, details: { ...details, output: { text: [] } } },
		null,
	])
		expect(isBackgroundCommandCompletionMessage(invalid)).toBe(false);
});

test("chat resources introduce scoped reads and cancellation, never browser command execution", () => {
	expect(WS_CHANNELS.sessionResourcesChanged).toBe("session.resourcesChanged");
	expect(WS_METHODS.sessionResources).toBe("session.resources");
	expect(WS_METHODS.backgroundCommandOutput).toBe("backgroundCommand.output");
	expect(WS_METHODS.backgroundCommandStop).toBe("backgroundCommand.stop");
	expect(WS_METHODS.subagentStop).toBe("subagent.stop");
	expect(WS_METHODS.subagentStopAll).toBe("subagent.stopAll");
	expect(Object.values(WS_METHODS)).not.toContain("backgroundCommand.start");
});

test("resource history pages a chat's finished records from v96", () => {
	expect(WS_METHODS.sessionResourceHistory).toBe("session.resourceHistory");
});

describe("completionDelivery", () => {
	test("reads the delivery marker and treats a missing or unknown value as absent", () => {
		expect(completionDelivery({ delivery: "wake" })).toBe("wake");
		expect(completionDelivery({ delivery: "run" })).toBe("run");
		expect(completionDelivery({ delivery: "appended" })).toBe("appended");
		expect(completionDelivery({})).toBeUndefined();
		expect(completionDelivery({ delivery: "later" })).toBeUndefined();
	});
});

describe("tool response guards", () => {
	test("isToolResponsePending recognises the pending marker only", () => {
		expect(isToolResponsePending({ kind: "ack" })).toBe(true);
		expect(isToolResponsePending({ kind: "other" })).toBe(false);
		expect(isToolResponsePending({ answers: [], cancelled: true })).toBe(false);
		expect(isToolResponsePending(undefined)).toBe(false);
		expect(isToolResponsePending("ack")).toBe(false);
	});

	test("readToolResponseMessage reads the tool-response custom message", () => {
		const message = {
			role: "custom",
			customType: TOOL_RESPONSE_CUSTOM_TYPE,
			details: { toolCallId: "tc", response: { picked: "A" } },
		};
		expect(readToolResponseMessage(message)).toEqual({
			toolCallId: "tc",
			response: { picked: "A" },
		});
		expect(readToolResponseMessage({ ...message, customType: "other" })).toBeNull();
		expect(readToolResponseMessage({ ...message, details: { toolCallId: "tc" } })).toBeNull();
		expect(readToolResponseMessage({ ...message, details: { response: {} } })).toBeNull();
		expect(readToolResponseMessage({ ...message, role: "user" })).toBeNull();
		expect(readToolResponseMessage(null)).toBeNull();
	});

	test("readToolResponseMessage still reads the legacy ask-user-answers shape", () => {
		const result = { answers: [], cancelled: true };
		expect(
			readToolResponseMessage({
				role: "custom",
				customType: "ask-user-answers",
				details: { toolCallId: "tc", result },
			}),
		).toEqual({ toolCallId: "tc", response: result });
		expect(
			readToolResponseMessage({
				role: "custom",
				customType: "ask-user-answers",
				details: { toolCallId: "tc" },
			}),
		).toBeNull();
	});
});

test("provider warnings are pinned to v99", () => {
	expect(WS_METHODS.providerDisableWarning).toBe("provider.disableWarning");
});

test("custom endpoints are pinned to v101 and own only custom-* providers", () => {
	expect(WS_METHODS.customEndpointsProbe).toBe("customEndpoints.probe");
	expect(isCustomEndpointId(`${CUSTOM_ENDPOINT_ID_PREFIX}gateway`)).toBe(true);
	expect(isCustomEndpointId("ollama")).toBe(false);
});

test("extension settings are pinned to v105", () => {
	expect(DEFAULT_CONFIG.extensionSettings).toEqual({});
});
