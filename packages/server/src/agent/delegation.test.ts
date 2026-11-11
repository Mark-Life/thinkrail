import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { WorkspaceId } from "@thinkrail/contracts";
import { type SessionId, SUBAGENT_COMPLETION_CUSTOM_TYPE } from "@thinkrail/contracts";
import { testSessionId, testWorkspaceId } from "@thinkrail/contracts/test-ids";
import { errorCodeOf } from "@thinkrail/shared/codedError";
import { delegationSessionDir } from "pi-delegation";
import { SUBAGENT_COMPLETION_MESSAGE } from "pi-subagents";
import { setTrashImplementationForTests } from "../trash";
import {
	createSession,
	deleteSession,
	disposeAllSessions,
	getSessionStats,
	liveParentContext,
	recordSessionUsage,
	removeSession,
	removeWorkspaceSessions,
	setSessionManagerFactory,
	setSessionPublisher,
	settleSessionsForShutdown,
} from "./agentSessionManager";
import {
	delegationRootDir,
	delegationServiceFor,
	readChildTranscript,
	reconcileSessionSubagentUsage,
	refreshSubagentConcurrency,
	setSubagentConcurrencyResolver,
} from "./delegation";
import { configurePiRuntime } from "./piRuntime";
import { childFileUsage } from "./subagentUsage";

const faux = createFauxCore({
	provider: "faux",
	api: "faux",
	models: [
		{
			id: "faux",
			name: "faux",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 4096,
		},
	],
	tokensPerSecond: 4000,
});

const tmpDirs: string[] = [];
function tmpDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

let priorAgentDir: string | undefined;
let priorDataDir: string | undefined;
let priorOffline: string | undefined;
let baseRuntime: ModelRuntime;

beforeAll(async () => {
	priorAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpDir("trdel-agentdir-");
	priorDataDir = process.env.THINKRAIL_DATA_DIR;
	process.env.THINKRAIL_DATA_DIR = tmpDir("trdel-data-");
	priorOffline = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "1";

	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	baseRuntime = runtime;
	runtime.registerProvider("faux", {
		api: faux.api,
		baseUrl: "http://faux.local",
		apiKey: "faux",
		streamSimple: faux.streamSimple,
		models: [
			{
				id: "faux",
				name: "faux",
				api: faux.api,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4096,
			},
		],
	});
	configurePiRuntime(runtime);
	setSessionManagerFactory((cwd) => SessionManager.inMemory(cwd));
	setSessionPublisher(() => {});
});

afterAll(() => {
	disposeAllSessions();
	configurePiRuntime(null);
	if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
	if (priorDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = priorDataDir;
	if (priorOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = priorOffline;
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

test("host embedding: projection, per-workspace service, transcript store, cascades, retention", async () => {
	const cwd = tmpDir("trdel-ws-");
	const { sessionId } = await createSession({ cwd, workspaceId: testWorkspaceId("ws-del") });

	const parent = liveParentContext(sessionId);
	expect(parent?.cwd).toBe(cwd);
	expect(parent?.model?.provider).toBe("faux");
	expect(parent?.modelRuntime).toBe(baseRuntime);
	expect(liveParentContext(testSessionId("not-a-session"))).toBeUndefined();

	const service = delegationServiceFor(testWorkspaceId("ws-del"));
	expect(delegationServiceFor(testWorkspaceId("ws-del"))).toBe(service);
	expect(delegationServiceFor(testWorkspaceId("ws-other"))).not.toBe(service);

	faux.setResponses([fauxAssistantMessage("CHILD_DONE")]);
	const child = await service.createChild({
		parent: sessionId,
		visibility: "hidden",
		info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
		session: { systemPrompt: "You are a test scout." },
	});
	const outcome = await child.runQueued("Report.");
	expect(outcome.status).toBe("completed");
	expect(child.record.sessionFile.startsWith(join(delegationRootDir(), "ws-del"))).toBe(true);

	const read = readChildTranscript(
		testWorkspaceId("ws-del"),
		sessionId,
		testSessionId(child.sessionId),
	);
	expect(JSON.stringify(read.messages)).toContain("CHILD_DONE");
	expect(read.status).toBe("completed");

	const childManager = SessionManager.open(child.record.sessionFile);
	const lastEntryId = childManager.getEntries().at(-1)?.id;
	if (!lastEntryId) throw new Error("expected child entries");
	childManager.appendCompaction("COMPACTED_CONTEXT", lastEntryId, 12_345);
	const compacted = readChildTranscript(
		testWorkspaceId("ws-del"),
		sessionId,
		testSessionId(child.sessionId),
	);
	expect(
		compacted.messages.some(
			(message) => message.role === "compactionSummary" && message.summary === "COMPACTED_CONTEXT",
		),
	).toBe(true);

	await removeSession(sessionId);
	expect(service.findChild(child.sessionId)).toBeUndefined();
	const afterDispose = readChildTranscript(
		testWorkspaceId("ws-del"),
		sessionId,
		testSessionId(child.sessionId),
	);
	expect(afterDispose.messages.length).toBeGreaterThan(0);
	expect(afterDispose.status).toBeUndefined();

	await removeWorkspaceSessions(testWorkspaceId("ws-del"));
	let missing: unknown;
	try {
		readChildTranscript(testWorkspaceId("ws-del"), sessionId, testSessionId(child.sessionId));
	} catch (err) {
		missing = err;
	}
	expect(String(missing)).toContain("No transcript found");
	expect(errorCodeOf(missing)).toBe("SUBAGENT_TRANSCRIPT_NOT_FOUND");
});

async function createSessionWith(
	factory: (dir: string) => SessionManager,
	input: Parameters<typeof createSession>[0],
) {
	setSessionManagerFactory(factory);
	try {
		return await createSession(input);
	} finally {
		setSessionManagerFactory((dir) => SessionManager.inMemory(dir));
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for condition");
		await Bun.sleep(10);
	}
}

function gatedChildResponse(): { release: () => void } {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	faux.setResponses([
		async () => {
			await gate;
			return fauxAssistantMessage("GATED_DONE");
		},
	]);
	return { release };
}

test("a child run's usage delta lands in the parent's pi totals and invalidates its stats", async () => {
	const cwd = tmpDir("trdel-usage-");
	let parentManager: SessionManager | undefined;
	const { sessionId } = await createSessionWith(
		(dir) => {
			parentManager = SessionManager.inMemory(dir);
			return parentManager;
		},
		{ cwd, workspaceId: testWorkspaceId("ws-usage") },
	);
	const published: unknown[] = [];
	setSessionPublisher((payload) => {
		if (payload.sessionId === sessionId) published.push(payload.event);
	});
	try {
		expect(getSessionStats(sessionId).tokens.total).toBe(0);
		faux.setResponses([fauxAssistantMessage("CHILD_DONE")]);
		const child = await delegationServiceFor(testWorkspaceId("ws-usage")).createChild({
			parent: sessionId,
			visibility: "hidden",
			info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
			session: { systemPrompt: "You are a test scout." },
		});
		const { usage } = (await child.runQueued("Report.")).details;
		expect(usage.input + usage.output).toBeGreaterThan(0);

		const { tokens } = getSessionStats(sessionId);
		expect(tokens).toMatchObject({
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
		});
		const recorded = parentManager?.getEntries().filter((entry) => entry.type === "usage");
		expect(recorded).toMatchObject([
			{ kind: "subagent", provider: "faux", model: "faux", note: child.sessionId },
		]);
		expect(published).toContainEqual({ type: "entry_appended", entryType: "usage" });

		await child.dispose();
		expect(
			childFileUsage(
				testSessionId(child.sessionId),
				readFileSync(child.record.sessionFile, "utf8"),
			),
		).toMatchObject({
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				cost: { total: usage.cost },
			},
		});
		await reconcileSessionSubagentUsage(testWorkspaceId("ws-usage"), sessionId, () =>
			parentManager?.getEntries(),
		);
		expect(parentManager?.getEntries().filter((entry) => entry.type === "usage")).toHaveLength(1);
	} finally {
		setSessionPublisher(() => {});
		await removeSession(sessionId);
	}
});

test("the subagent totals mirror matches pi's own totals for every spend source", async () => {
	const cwd = tmpDir("trdel-parity-");
	const spend = (seed: number, total: number) => ({
		input: seed,
		output: seed + 1,
		cacheRead: seed + 2,
		cacheWrite: seed + 3,
		totalTokens: 4 * seed + 6,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
	});
	const transcript = SessionManager.create(cwd, tmpDir("trdel-parity-sessions-"));
	transcript.appendMessage({ role: "user", content: "Find it.", timestamp: Date.now() });
	const askedId = transcript.appendMessage({
		...fauxAssistantMessage([fauxToolCall("search", { q: "it" }, { id: "call-1" })], {
			stopReason: "toolUse",
		}),
		usage: spend(10, 0.011),
	});
	transcript.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "search",
		content: [{ type: "text", text: "found" }],
		isError: false,
		usage: spend(20, 0.022),
		timestamp: Date.now(),
	});
	transcript.appendCompaction("Compacted.", askedId, 1_000, undefined, false, spend(30, 0.033));
	transcript.branchWithSummary(askedId, "Abandoned branch.", undefined, false, spend(40, 0.044));
	transcript.appendUsage("cache_warm", "faux", "faux", spend(50, 0.055));
	const file = transcript.getSessionFile();
	if (!file) throw new Error("expected a persisted transcript");

	const { sessionId } = await createSessionWith(() => SessionManager.open(file), {
		cwd,
		workspaceId: testWorkspaceId("ws-parity"),
	});
	try {
		const pi = getSessionStats(sessionId);
		expect(pi.tokens).toMatchObject({ input: 150, output: 155, cacheRead: 160, cacheWrite: 165 });
		expect(pi.cost).toBeCloseTo(0.165, 12);
		const mirror = childFileUsage(
			testSessionId(transcript.getSessionId()),
			readFileSync(file, "utf8"),
		);
		expect(mirror?.usage).toMatchObject({
			input: pi.tokens.input,
			output: pi.tokens.output,
			cacheRead: pi.tokens.cacheRead,
			cacheWrite: pi.tokens.cacheWrite,
		});
		expect(mirror?.usage.cost.total).toBeCloseTo(pi.cost, 12);
	} finally {
		await removeSession(sessionId);
	}
});

async function parentWithGatedChild(workspaceId: WorkspaceId) {
	let parentManager: SessionManager | undefined;
	const cwd = tmpDir(`trdel-${workspaceId}-`);
	const { sessionId } = await createSessionWith(
		(dir) => {
			parentManager = SessionManager.inMemory(dir);
			return parentManager;
		},
		{ cwd, workspaceId },
	);
	const { release } = gatedChildResponse();
	const child = await delegationServiceFor(workspaceId).createChild({
		parent: sessionId,
		visibility: "hidden",
		info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
		session: { systemPrompt: "You are a test scout." },
	});
	const run = child.runQueued("Long background job.");
	await waitFor(() => child.snapshot?.status === "running");
	const usageEntries = () =>
		parentManager?.getEntries().filter((entry) => entry.type === "usage") ?? [];
	return { cwd, sessionId, child, run, release, usageEntries, parentManager };
}

test("attaching a chat recovers the spend of children a crashed host never recorded", async () => {
	const cwd = tmpDir("trdel-crash-");
	let parentManager: SessionManager | undefined;
	let orphanId = "";
	const { sessionId } = await createSessionWith(
		(dir) => {
			parentManager = SessionManager.inMemory(dir);
			const orphan = SessionManager.create(
				cwd,
				delegationSessionDir(delegationRootDir(), "ws-crash", parentManager.getSessionId()),
			);
			orphan.appendMessage({ role: "user", content: "Long job.", timestamp: Date.now() });
			orphan.appendMessage({
				...fauxAssistantMessage("partial"),
				provider: "faux",
				model: "faux",
				usage: {
					input: 120,
					output: 30,
					cacheRead: 4_000,
					cacheWrite: 500,
					totalTokens: 4_650,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
				},
			});
			orphanId = orphan.getSessionId();
			return parentManager;
		},
		{ cwd, workspaceId: testWorkspaceId("ws-crash") },
	);
	try {
		await waitFor(() => getSessionStats(sessionId).tokens.total > 0);
		expect(getSessionStats(sessionId)).toMatchObject({
			tokens: { input: 120, output: 30, cacheRead: 4_000, cacheWrite: 500 },
			cost: 0.25,
		});
		const usageEntries = () => parentManager?.getEntries().filter((e) => e.type === "usage");
		expect(usageEntries()).toMatchObject([
			{ kind: "subagent", provider: "faux", model: "faux", note: orphanId },
		]);
		await reconcileSessionSubagentUsage(testWorkspaceId("ws-crash"), sessionId, () =>
			parentManager?.getEntries(),
		);
		expect(usageEntries()).toHaveLength(1);
	} finally {
		await removeSession(sessionId);
	}
});

test("closing a chat still records the usage of a child its cascade stops", async () => {
	const { sessionId, child, run, release, usageEntries } = await parentWithGatedChild(
		testWorkspaceId("ws-close"),
	);
	const closed = removeSession(sessionId);
	await waitFor(() => liveParentContext(sessionId) === undefined);
	release();
	await Promise.all([closed, run]);
	expect(usageEntries()).toMatchObject([{ kind: "subagent", note: child.sessionId }]);
});

test("deleting a chat never appends usage to its trashed transcript", async () => {
	const { cwd, sessionId, run, release, usageEntries } = await parentWithGatedChild(
		testWorkspaceId("ws-delusage"),
	);
	const deleted = deleteSession(sessionId, testWorkspaceId("ws-delusage"), cwd);
	await waitFor(() => liveParentContext(sessionId) === undefined);
	release();
	await Promise.all([deleted, run]);
	expect(usageEntries()).toEqual([]);
});

test("a failed usage write never fails the child run", async () => {
	const { sessionId, child, run, release, usageEntries, parentManager } =
		await parentWithGatedChild(testWorkspaceId("ws-enospc"));
	if (!parentManager) throw new Error("expected a parent session manager");
	parentManager.appendUsage = () => {
		throw new Error("ENOSPC: no space left on device");
	};
	try {
		release();
		expect((await run).status).toBe("completed");
		expect(child.snapshot?.status).toBe("completed");
		expect(usageEntries()).toEqual([]);
	} finally {
		await removeSession(sessionId);
	}
});

const writesCanBeDenied = (() => {
	const dir = mkdtempSync(join(tmpdir(), "trdel-perm-"));
	const file = join(dir, "probe");
	writeFileSync(file, "");
	chmodSync(file, 0o444);
	try {
		appendFileSync(file, "x");
		return false;
	} catch {
		return true;
	} finally {
		chmodSync(file, 0o644);
		rmSync(dir, { recursive: true, force: true });
	}
})();

async function persistedParent(workspaceId: WorkspaceId) {
	let manager: SessionManager | undefined;
	const cwd = tmpDir(`trdel-${workspaceId}-`);
	const { sessionId } = await createSessionWith(
		(dir) => {
			manager = SessionManager.create(dir);
			return manager;
		},
		{ cwd, workspaceId },
	);
	if (!manager) throw new Error("expected a parent session manager");
	manager.appendMessage({ role: "user", content: "BEFORE", timestamp: Date.now() });
	const file = manager.getSessionFile();
	if (!file) throw new Error("expected a persisted parent transcript");
	return { cwd, sessionId, manager, file };
}

function userTexts(manager: SessionManager): string[] {
	return manager
		.buildSessionContext()
		.messages.flatMap((message) =>
			message.role === "user" && typeof message.content === "string" ? [message.content] : [],
		);
}

const subagentSpend = (input: number, note: string) => ({
	kind: "subagent",
	provider: "faux",
	model: "faux",
	note,
	usage: {
		input,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + 1,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
	},
});

const totalTokens = (usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}) => usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

test.skipIf(!writesCanBeDenied)(
	"a failed usage write leaves pi's memory and leaf untouched and never cuts the reopened history",
	async () => {
		const { sessionId, manager, file } = await persistedParent(testWorkspaceId("ws-memonly"));
		const { release } = gatedChildResponse();
		try {
			const child = await delegationServiceFor(testWorkspaceId("ws-memonly")).createChild({
				parent: sessionId,
				visibility: "hidden",
				info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
				session: { systemPrompt: "You are a test scout." },
			});
			const run = child.runQueued("Long background job.");
			await waitFor(() => child.snapshot?.status === "running");
			chmodSync(file, 0o444);
			release();
			const outcome = await run;
			chmodSync(file, 0o644);
			expect(outcome.status).toBe("completed");
			expect(totalTokens(outcome.details.usage)).toBeGreaterThan(0);
			expect(getSessionStats(sessionId).tokens.total).toBe(0);
			expect(manager.getLeafEntry()?.type).not.toBe("usage");

			manager.appendMessage({ role: "user", content: "AFTER", timestamp: Date.now() });
			const reopened = SessionManager.open(file);
			expect(userTexts(reopened)).toEqual(["BEFORE", "AFTER"]);
			expect(reopened.getEntries().some((entry) => entry.type === "usage")).toBe(false);
		} finally {
			release();
			chmodSync(file, 0o644);
			await removeSession(sessionId);
		}
	},
);

test.skipIf(!writesCanBeDenied)(
	"reopening a chat restores subagent spend whose write failed",
	async () => {
		const { cwd, sessionId, file } = await persistedParent(testWorkspaceId("ws-reopen"));
		faux.setResponses([fauxAssistantMessage("CHILD_DONE")]);
		const child = await delegationServiceFor(testWorkspaceId("ws-reopen")).createChild({
			parent: sessionId,
			visibility: "hidden",
			info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
			session: { systemPrompt: "You are a test scout." },
		});
		chmodSync(file, 0o444);
		const outcome = await child.runQueued("Report.").finally(() => chmodSync(file, 0o644));
		const { usage } = outcome.details;
		await removeSession(sessionId);
		expect(
			SessionManager.open(file)
				.getEntries()
				.some((entry) => entry.type === "usage"),
		).toBe(false);

		const reopened = await createSessionWith(() => SessionManager.open(file), {
			cwd,
			workspaceId: testWorkspaceId("ws-reopen"),
		});
		try {
			expect(reopened.sessionId).toBe(sessionId);
			await waitFor(() => getSessionStats(sessionId).tokens.total === totalTokens(usage));
			expect(getSessionStats(sessionId).tokens).toMatchObject({
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
			});
		} finally {
			await removeSession(sessionId);
		}
	},
);

test("a torn usage append is cut back so the next entry stays readable", async () => {
	const { sessionId, manager, file } = await persistedParent(testWorkspaceId("ws-torn"));
	const appendUsage = manager.appendUsage.bind(manager);
	try {
		manager.appendUsage = () => {
			appendFileSync(file, '{"type":"message","id":"torn');
			throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
		};
		const sizeBefore = statSync(file).size;
		expect(recordSessionUsage(sessionId, subagentSpend(40, "child-torn"))).toBe(false);
		expect(statSync(file).size).toBe(sizeBefore);
		expect(getSessionStats(sessionId).tokens.total).toBe(0);

		manager.appendUsage = appendUsage;
		manager.appendMessage({ role: "user", content: "AFTER", timestamp: Date.now() });
		const reopened = SessionManager.open(file);
		expect(userTexts(reopened)).toEqual(["BEFORE", "AFTER"]);
		expect(reopened.getEntries().some((entry) => entry.type === "usage")).toBe(false);
	} finally {
		manager.appendUsage = appendUsage;
		await removeSession(sessionId);
	}
});

test("usage accounting survives a throwing publisher and an unreadable transcript path", async () => {
	const { sessionId, manager, file } = await persistedParent(testWorkspaceId("ws-besteffort"));
	const getSessionFile = manager.getSessionFile.bind(manager);
	try {
		setSessionPublisher(() => {
			throw new Error("socket closed");
		});
		expect(recordSessionUsage(sessionId, subagentSpend(10, "child-a"))).toBe(true);
		setSessionPublisher(() => {});
		manager.getSessionFile = () => join(file, "missing");
		expect(recordSessionUsage(sessionId, subagentSpend(20, "child-b"))).toBe(true);
		manager.getSessionFile = getSessionFile;
		const onDisk = SessionManager.open(file).getEntries();
		expect(onDisk.filter((entry) => entry.type === "usage")).toHaveLength(2);
	} finally {
		setSessionPublisher(() => {});
		manager.getSessionFile = getSessionFile;
		await removeSession(sessionId);
	}
});

test.skipIf(!writesCanBeDenied)("a cut-back that cannot truncate never throws", async () => {
	const { sessionId, manager, file } = await persistedParent(testWorkspaceId("ws-notrunc"));
	const appendUsage = manager.appendUsage.bind(manager);
	try {
		manager.appendUsage = () => {
			appendFileSync(file, '{"type":"message","id":"torn');
			chmodSync(file, 0o444);
			throw Object.assign(new Error("EIO: i/o error, close"), { code: "EIO" });
		};
		expect(recordSessionUsage(sessionId, subagentSpend(30, "child-c"))).toBe(false);
		expect(manager.getLeafEntry()?.type).not.toBe("usage");
	} finally {
		chmodSync(file, 0o644);
		manager.appendUsage = appendUsage;
		await removeSession(sessionId);
	}
});

test("a failed deletion recovers the usage of a child that settled while trash was pending", async () => {
	let reportTrashStarted: () => void = () => {};
	const trashStarted = new Promise<void>((resolve) => {
		reportTrashStarted = resolve;
	});
	let failTrash: () => void = () => {};
	const trashOutcome = new Promise<void>((_resolve, reject) => {
		failTrash = () => reject(new Error("recycle bin unavailable"));
	});
	setTrashImplementationForTests(async () => {
		reportTrashStarted();
		await trashOutcome;
	});
	let parentManager: SessionManager | undefined;
	const cwd = tmpDir("trdel-trashfail-");
	const { sessionId } = await createSessionWith(
		(dir) => {
			parentManager = SessionManager.create(dir);
			return parentManager;
		},
		{ cwd, workspaceId: testWorkspaceId("ws-trashfail") },
	);
	parentManager?.appendMessage({ role: "user", content: "persist", timestamp: Date.now() });
	const { release } = gatedChildResponse();
	try {
		const child = await delegationServiceFor(testWorkspaceId("ws-trashfail")).createChild({
			parent: sessionId,
			visibility: "hidden",
			info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
			session: { systemPrompt: "You are a test scout." },
		});
		const run = child.runQueued("Long background job.");
		await waitFor(() => child.snapshot?.status === "running");
		const deleting = deleteSession(sessionId, testWorkspaceId("ws-trashfail"), cwd);
		await trashStarted;
		release();
		await run;
		const usageEntries = () => parentManager?.getEntries().filter((e) => e.type === "usage") ?? [];
		expect(usageEntries()).toEqual([]);

		failTrash();
		await expect(deleting).rejects.toThrow("recycle bin unavailable");
		await waitFor(() => usageEntries().length > 0);
		expect(usageEntries()).toMatchObject([{ kind: "subagent", note: child.sessionId }]);
	} finally {
		failTrash();
		setTrashImplementationForTests(undefined);
		await removeSession(sessionId);
	}
});

function twoStepChildResponses(): { release: () => void } {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("no_such_tool", {})], { stopReason: "toolUse" }),
		async () => {
			await gate;
			return fauxAssistantMessage("DONE");
		},
	]);
	return { release };
}

function scoutChild(workspaceId: WorkspaceId, parent: string) {
	return delegationServiceFor(workspaceId).createChild({
		parent,
		visibility: "hidden",
		info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
		session: { systemPrompt: "You are a test scout." },
	});
}

const tokenCounts = (usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}) => ({
	input: usage.input,
	output: usage.output,
	cacheRead: usage.cacheRead,
	cacheWrite: usage.cacheWrite,
});

async function inMemoryParent(workspaceId: WorkspaceId) {
	let manager: SessionManager | undefined;
	const { sessionId } = await createSessionWith(
		(dir) => {
			manager = SessionManager.inMemory(dir);
			return manager;
		},
		{ cwd: tmpDir(`trdel-${workspaceId}-`), workspaceId },
	);
	if (!manager) throw new Error("expected a parent session manager");
	const parent = manager;
	const usageEntries = () => parent.getEntries().filter((entry) => entry.type === "usage");
	return { sessionId, manager: parent, usageEntries };
}

test("a running subagent's spend reaches its parent after each response, before the run ends", async () => {
	const { sessionId, manager, usageEntries } = await inMemoryParent(testWorkspaceId("ws-live"));
	const { release } = twoStepChildResponses();
	try {
		const child = await scoutChild(testWorkspaceId("ws-live"), sessionId);
		const run = child.runQueued("Two steps.");
		await waitFor(() => usageEntries().length > 0);
		expect(child.snapshot?.status).toBe("running");
		const firstStep = getSessionStats(sessionId).tokens.total;
		expect(firstStep).toBeGreaterThan(0);

		release();
		const { usage } = (await run).details;
		const { tokens } = getSessionStats(sessionId);
		expect(tokens.total).toBeGreaterThan(firstStep);
		expect(tokenCounts(tokens)).toEqual(tokenCounts(usage));
		const recorded = usageEntries().length;
		expect(recorded).toBeGreaterThanOrEqual(2);
		await child.dispose();
		await reconcileSessionSubagentUsage(testWorkspaceId("ws-live"), sessionId, () =>
			manager.getEntries(),
		);
		expect(usageEntries()).toHaveLength(recorded);
	} finally {
		release();
		await removeSession(sessionId);
	}
});

test("a live-recorded run stays exact after its chat is reopened", async () => {
	const { cwd, sessionId, file } = await persistedParent(testWorkspaceId("ws-livereopen"));
	const { release } = twoStepChildResponses();
	let reopened: SessionManager | undefined;
	try {
		const child = await scoutChild(testWorkspaceId("ws-livereopen"), sessionId);
		const run = child.runQueued("Two steps.");
		await waitFor(() => getSessionStats(sessionId).tokens.total > 0);
		release();
		const { usage } = (await run).details;
		await removeSession(sessionId);
		const onDisk = SessionManager.open(file).getEntries();
		const recorded = onDisk.filter((entry) => entry.type === "usage").length;
		expect(recorded).toBeGreaterThanOrEqual(2);

		await createSessionWith(
			() => {
				reopened = SessionManager.open(file);
				return reopened;
			},
			{ cwd, workspaceId: testWorkspaceId("ws-livereopen") },
		);
		await reconcileSessionSubagentUsage(testWorkspaceId("ws-livereopen"), sessionId, () =>
			reopened?.getEntries(),
		);
		expect(reopened?.getEntries().filter((entry) => entry.type === "usage")).toHaveLength(recorded);
		expect(tokenCounts(getSessionStats(sessionId).tokens)).toEqual(tokenCounts(usage));
	} finally {
		release();
		await removeSession(sessionId);
	}
});

test.skipIf(!writesCanBeDenied)(
	"a failed progress write is carried by the terminal write and not recounted after reopening",
	async () => {
		const { cwd, sessionId, manager, file } = await persistedParent(
			testWorkspaceId("ws-progressfail"),
		);
		const appendUsage = manager.appendUsage.bind(manager);
		let attempts = 0;
		manager.appendUsage = (...args) => {
			attempts += 1;
			return appendUsage(...args);
		};
		const { release } = twoStepChildResponses();
		try {
			const child = await scoutChild(testWorkspaceId("ws-progressfail"), sessionId);
			chmodSync(file, 0o444);
			const run = child.runQueued("Two steps.");
			await waitFor(() => attempts > 0);
			expect(getSessionStats(sessionId).tokens.total).toBe(0);
			chmodSync(file, 0o644);
			release();
			const { usage } = (await run).details;
			expect(tokenCounts(getSessionStats(sessionId).tokens)).toEqual(tokenCounts(usage));
			await removeSession(sessionId);
			const onDisk = SessionManager.open(file).getEntries();
			expect(onDisk.filter((entry) => entry.type === "usage")).toHaveLength(1);

			await createSessionWith(() => SessionManager.open(file), {
				cwd,
				workspaceId: testWorkspaceId("ws-progressfail"),
			});
			await waitFor(() => getSessionStats(sessionId).tokens.total === totalTokens(usage));
			expect(tokenCounts(getSessionStats(sessionId).tokens)).toEqual(tokenCounts(usage));
		} finally {
			release();
			chmodSync(file, 0o644);
			manager.appendUsage = appendUsage;
			await removeSession(sessionId);
		}
	},
);

test("sequential runs of one child each record only their own spend", async () => {
	const { sessionId } = await inMemoryParent(testWorkspaceId("ws-reuse"));
	faux.setResponses([fauxAssistantMessage("FIRST"), fauxAssistantMessage("SECOND")]);
	try {
		const child = await scoutChild(testWorkspaceId("ws-reuse"), sessionId);
		const first = (await child.runQueued("One.")).details.usage;
		const second = (await child.runQueued("Two.")).details.usage;
		expect(tokenCounts(getSessionStats(sessionId).tokens)).toEqual({
			input: first.input + second.input,
			output: first.output + second.output,
			cacheRead: first.cacheRead + second.cacheRead,
			cacheWrite: first.cacheWrite + second.cacheWrite,
		});
	} finally {
		await removeSession(sessionId);
	}
});

test("a dropped progress write is carried by the run's remainder", async () => {
	const { sessionId, manager } = await inMemoryParent(testWorkspaceId("ws-dropprogress"));
	const appendUsage = manager.appendUsage.bind(manager);
	let failures = 1;
	manager.appendUsage = (...args) => {
		if (failures-- > 0) throw new Error("EAGAIN: resource temporarily unavailable");
		return appendUsage(...args);
	};
	faux.setResponses([fauxAssistantMessage("DONE")]);
	try {
		const child = await scoutChild(testWorkspaceId("ws-dropprogress"), sessionId);
		const { usage } = (await child.runQueued("One.")).details;
		expect(failures).toBe(-1);
		expect(tokenCounts(getSessionStats(sessionId).tokens)).toEqual(tokenCounts(usage));
	} finally {
		manager.appendUsage = appendUsage;
		await removeSession(sessionId);
	}
});

test("a dropped terminal write is recovered by reconciliation, never by the child's next run", async () => {
	const { sessionId, manager } = await inMemoryParent(testWorkspaceId("ws-dropterminal"));
	const appendUsage = manager.appendUsage.bind(manager);
	let failing = true;
	manager.appendUsage = (...args) => {
		if (failing) throw new Error("EAGAIN: resource temporarily unavailable");
		return appendUsage(...args);
	};
	faux.setResponses([fauxAssistantMessage("FIRST"), fauxAssistantMessage("SECOND")]);
	try {
		const child = await scoutChild(testWorkspaceId("ws-dropterminal"), sessionId);
		const first = (await child.runQueued("One.")).details.usage;
		failing = false;
		const second = (await child.runQueued("Two.")).details.usage;
		expect(totalTokens(first)).toBeGreaterThan(0);
		expect(totalTokens(second)).toBeGreaterThan(0);
		expect(tokenCounts(getSessionStats(sessionId).tokens)).toEqual(tokenCounts(second));

		await child.dispose();
		await reconcileSessionSubagentUsage(testWorkspaceId("ws-dropterminal"), sessionId, () =>
			manager.getEntries(),
		);
		expect(tokenCounts(getSessionStats(sessionId).tokens)).toEqual({
			input: first.input + second.input,
			output: first.output + second.output,
			cacheRead: first.cacheRead + second.cacheRead,
			cacheWrite: first.cacheWrite + second.cacheWrite,
		});
	} finally {
		manager.appendUsage = appendUsage;
		await removeSession(sessionId);
	}
});

test("a failed deletion after partial progress records only the missing remainder", async () => {
	let reportTrashStarted: () => void = () => {};
	const trashStarted = new Promise<void>((resolve) => {
		reportTrashStarted = resolve;
	});
	let failTrash: () => void = () => {};
	const trashOutcome = new Promise<void>((_resolve, reject) => {
		failTrash = () => reject(new Error("recycle bin unavailable"));
	});
	setTrashImplementationForTests(async () => {
		reportTrashStarted();
		await trashOutcome;
	});
	const { cwd, sessionId, manager } = await persistedParent(testWorkspaceId("ws-partialdelete"));
	const usageEntries = () => manager.getEntries().filter((entry) => entry.type === "usage");
	const { release } = twoStepChildResponses();
	try {
		const child = await scoutChild(testWorkspaceId("ws-partialdelete"), sessionId);
		const run = child.runQueued("Two steps.");
		await waitFor(() => usageEntries().length > 0);
		const partial = usageEntries().length;
		const deleting = deleteSession(sessionId, testWorkspaceId("ws-partialdelete"), cwd);
		await trashStarted;
		release();
		const { usage } = (await run).details;
		expect(usageEntries()).toHaveLength(partial);

		failTrash();
		await expect(deleting).rejects.toThrow("recycle bin unavailable");
		await waitFor(() => getSessionStats(sessionId).tokens.total === totalTokens(usage));
		expect(tokenCounts(getSessionStats(sessionId).tokens)).toEqual(tokenCounts(usage));
	} finally {
		failTrash();
		release();
		setTrashImplementationForTests(undefined);
		await removeSession(sessionId);
	}
});

test("emergency disposal never lets a late subagent record recreate a trashed transcript", async () => {
	const { cwd, sessionId, file } = await persistedParent(testWorkspaceId("ws-emergency"));
	setTrashImplementationForTests(async (input) => {
		for (const path of typeof input === "string" ? [input] : input) {
			renameSync(path, `${path}.trashed`);
		}
	});
	const { release } = gatedChildResponse();
	try {
		const child = await scoutChild(testWorkspaceId("ws-emergency"), sessionId);
		const run = child.runQueued("Long background job.");
		await waitFor(() => child.snapshot?.status === "running");
		const deleting = deleteSession(sessionId, testWorkspaceId("ws-emergency"), cwd);
		await waitFor(() => !existsSync(file) && liveParentContext(sessionId) === undefined);
		disposeAllSessions();
		release();
		expect(totalTokens((await run).details.usage)).toBeGreaterThan(0);
		await deleting;
		expect(existsSync(file)).toBe(false);
	} finally {
		release();
		setTrashImplementationForTests(undefined);
	}
});

test("spend dropped by emergency disposal during a close is recovered when the chat reopens", async () => {
	const { cwd, sessionId, file } = await persistedParent(testWorkspaceId("ws-closeemergency"));
	const { release } = gatedChildResponse();
	try {
		const child = await scoutChild(testWorkspaceId("ws-closeemergency"), sessionId);
		const run = child.runQueued("Long background job.");
		await waitFor(() => child.snapshot?.status === "running");
		const closed = removeSession(sessionId);
		await waitFor(() => liveParentContext(sessionId) === undefined);
		disposeAllSessions();
		release();
		const { usage } = (await run).details;
		await closed;
		expect(totalTokens(usage)).toBeGreaterThan(0);
		expect(
			SessionManager.open(file)
				.getEntries()
				.some((entry) => entry.type === "usage"),
		).toBe(false);

		await createSessionWith(() => SessionManager.open(file), {
			cwd,
			workspaceId: testWorkspaceId("ws-closeemergency"),
		});
		await waitFor(() => getSessionStats(sessionId).tokens.total === totalTokens(usage));
	} finally {
		release();
		await removeSession(sessionId);
	}
});

test("owned children remain inspectable before and during their first provider response", async () => {
	const cwd = tmpDir("trdel-prefile-");
	const workspaceId = testWorkspaceId("ws-prefile");
	const { sessionId } = await createSession({ cwd, workspaceId });
	const service = delegationServiceFor(workspaceId);
	const child = await service.createChild({
		parent: sessionId,
		info: { createdBy: "test" },
		visibility: "hidden",
		session: {},
	});
	expect(existsSync(child.record.sessionFile)).toBe(false);
	expect(readChildTranscript(workspaceId, sessionId, testSessionId(child.sessionId))).toEqual({
		messages: [],
		status: "queued",
	});
	for (const [workspace, parent, id] of [
		["foreign-workspace", sessionId, child.sessionId],
		[workspaceId, "foreign-parent", child.sessionId],
		[workspaceId, sessionId, "unknown-child"],
	] as const)
		expect(() =>
			readChildTranscript(testWorkspaceId(workspace), testSessionId(parent), testSessionId(id)),
		).toThrow("No transcript found");
	const { release } = gatedChildResponse();
	const run = child.runQueued("Wait for the provider.");
	try {
		await waitFor(() => child.snapshot?.status === "running");
		expect(existsSync(child.record.sessionFile)).toBe(true);
		expect(
			readChildTranscript(workspaceId, sessionId, testSessionId(child.sessionId)),
		).toMatchObject({
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Wait for the provider." }],
				},
			],
			status: "running",
		});
	} finally {
		release();
		await run;
	}
	expect(
		JSON.stringify(readChildTranscript(workspaceId, sessionId, testSessionId(child.sessionId))),
	).toContain("GATED_DONE");
	const canceled = await service.createChild({
		parent: sessionId,
		info: { createdBy: "test" },
		visibility: "hidden",
		session: {},
	});
	await canceled.runQueued("Never sent.", { signal: AbortSignal.abort() });
	expect(existsSync(canceled.record.sessionFile)).toBe(false);
	expect(readChildTranscript(workspaceId, sessionId, testSessionId(canceled.sessionId))).toEqual({
		messages: [],
		status: "aborted",
	});
	await removeSession(sessionId);
	expect(() =>
		readChildTranscript(workspaceId, sessionId, testSessionId(canceled.sessionId)),
	).toThrow("No transcript found");
});

test("deleteSession resolves only after its child cascade settles", async () => {
	const cwd = tmpDir("trdel-await-");
	const { sessionId } = await createSession({ cwd, workspaceId: testWorkspaceId("ws-await") });
	const service = delegationServiceFor(testWorkspaceId("ws-await"));
	const { release } = gatedChildResponse();
	const child = await service.createChild({
		parent: sessionId,
		visibility: "hidden",
		info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
		session: { systemPrompt: "You are a test scout." },
	});
	const run = child.runQueued("Long gated job.");
	await waitFor(() => child.snapshot?.status === "running");

	let deleted = false;
	const done = deleteSession(sessionId, testWorkspaceId("ws-await"), cwd).then(() => {
		deleted = true;
	});
	await waitFor(() => liveParentContext(sessionId) === undefined);
	expect(deleted).toBe(false);

	release();
	await done;
	expect(deleted).toBe(true);
	await run;
});

test("workspace archival awaits in-flight delete transactions before deleting the store", async () => {
	const cwd = tmpDir("trdel-arch-");
	const { sessionId } = await createSession({ cwd, workspaceId: testWorkspaceId("ws-arch") });
	const service = delegationServiceFor(testWorkspaceId("ws-arch"));
	const { release } = gatedChildResponse();
	const child = await service.createChild({
		parent: sessionId,
		visibility: "hidden",
		info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
		session: { systemPrompt: "You are a test scout." },
	});
	const run = child.runQueued("Long gated job.");
	await waitFor(() => child.snapshot?.status === "running");

	let storeAliveAtCascadeEnd: boolean | undefined;
	const unsubscribe = service.onLifecycle((event) => {
		if (event.type === "child-disposed" && event.sessionId === child.sessionId) {
			storeAliveAtCascadeEnd = existsSync(child.record.sessionFile);
		}
	});
	const done = deleteSession(sessionId, testWorkspaceId("ws-arch"), cwd);
	await waitFor(() => liveParentContext(sessionId) === undefined);
	const archived = removeWorkspaceSessions(testWorkspaceId("ws-arch"), cwd);
	release();
	await Promise.all([done, archived, run]);
	unsubscribe();
	expect(storeAliveAtCascadeEnd).toBe(true);
});

test("graceful shutdown waits for a background child cascade", async () => {
	const cwd = tmpDir("trdel-shutdown-");
	const { sessionId } = await createSession({ cwd, workspaceId: testWorkspaceId("ws-shutdown") });
	const service = delegationServiceFor(testWorkspaceId("ws-shutdown"));
	const { release } = gatedChildResponse();
	const child = await service.createChild({
		parent: sessionId,
		visibility: "hidden",
		info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
		session: { systemPrompt: "You are a test scout." },
	});
	const run = child.runQueued("Long background job.");
	await waitFor(() => child.snapshot?.status === "running");

	const settled = settleSessionsForShutdown(10_000).then(() => "settled" as const);
	expect(await Promise.race([settled, Promise.resolve("pending" as const)])).toBe("pending");
	release();
	await Promise.all([settled, run]);
	expect(service.findChild(child.sessionId)).toBeUndefined();
	await removeSession(sessionId);
});

test("children follow their parent's retained runtime generation across a flip", async () => {
	const cwdOld = tmpDir("trdel-flip-old-");
	const { sessionId: oldParent } = await createSession({
		cwd: cwdOld,
		workspaceId: testWorkspaceId("ws-flip"),
	});
	const service = delegationServiceFor(testWorkspaceId("ws-flip"));
	const gen2 = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	gen2.registerProvider("fauxg2", {
		api: faux.api,
		baseUrl: "http://faux.local",
		apiKey: "faux",
		streamSimple: faux.streamSimple,
		models: [
			{
				id: "fauxg2",
				name: "fauxg2",
				api: faux.api,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4096,
			},
		],
	});
	let newParent: string | undefined;
	try {
		configurePiRuntime(gen2);
		expect(liveParentContext(oldParent)?.modelRuntime).toBe(baseRuntime);
		faux.setResponses([fauxAssistantMessage("OLD_GEN_DONE")]);
		const oldChild = await service.createChild({
			parent: oldParent,
			visibility: "hidden",
			info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
			session: { systemPrompt: "old-parent probe" },
		});
		const oldOutcome = await oldChild.runQueued("Probe old.");
		expect(oldOutcome.status).toBe("completed");
		expect(oldOutcome.details.model).toBe("faux/faux");
		await oldChild.dispose();

		const cwdNew = tmpDir("trdel-flip-new-");
		({ sessionId: newParent } = await createSession({
			cwd: cwdNew,
			workspaceId: testWorkspaceId("ws-flip"),
		}));
		expect(liveParentContext(testSessionId(newParent))?.modelRuntime).toBe(gen2);
		faux.setResponses([fauxAssistantMessage("NEW_GEN_DONE")]);
		const newChild = await service.createChild({
			parent: newParent,
			visibility: "hidden",
			info: { createdBy: "tool:Agent", roleName: "scout", roleSource: "builtin" },
			session: { systemPrompt: "new-parent probe", model: { provider: "fauxg2", id: "fauxg2" } },
		});
		const newOutcome = await newChild.runQueued("Probe new.");
		expect(newOutcome.status).toBe("completed");
		expect(newOutcome.details.model).toBe("fauxg2/fauxg2");
	} finally {
		configurePiRuntime(baseRuntime);
		await removeSession(oldParent);
		if (newParent) await removeSession(testSessionId(newParent));
	}
});

function pngHeaderOnly(width: number, height: number): Buffer {
	const ihdr = Buffer.alloc(25);
	ihdr.writeUInt32BE(13, 0);
	ihdr.write("IHDR", 4, "ascii");
	ihdr.writeUInt32BE(width, 8);
	ihdr.writeUInt32BE(height, 12);
	ihdr[16] = 8;
	ihdr[17] = 2;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}

test("a child without extensions reads images raw and still gets the oversized-image guard", async () => {
	const cwd = tmpDir("trdel-image-");
	writeFileSync(join(cwd, "wide.png"), pngHeaderOnly(9000, 10));
	baseRuntime.registerProvider("faux-claude", {
		api: faux.api,
		baseUrl: "http://faux.local",
		apiKey: "faux",
		streamSimple: faux.streamSimple,
		models: [
			{
				id: "claude-faux",
				name: "claude-faux",
				api: faux.api,
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4096,
			},
		],
	});
	const { sessionId } = await createSession({ cwd, workspaceId: testWorkspaceId("ws-image") });
	let toolResult: unknown;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: "wide.png" })),
		(context) => {
			toolResult = context.messages.at(-1);
			return fauxAssistantMessage("SEEN");
		},
	]);
	try {
		const child = await delegationServiceFor(testWorkspaceId("ws-image")).createChild({
			parent: sessionId,
			visibility: "hidden",
			info: { createdBy: "tool:Agent", roleName: "custom", roleSource: "project" },
			session: { model: { provider: "faux-claude", id: "claude-faux" }, tools: ["read"] },
		});
		expect((await child.runQueued("Read wide.png.")).finalText).toBe("SEEN");
		const seen = JSON.stringify(toolResult);
		expect(seen).toContain("9000\u00d710 exceeds the provider's 8000px image-dimension limit");
		expect(seen).not.toContain("Image omitted");
	} finally {
		await removeSession(sessionId);
		baseRuntime.unregisterProvider("faux-claude");
	}
});

test("a child on a provider an extension registered loads that extension from its parent", async () => {
	const owner = join(process.env.PI_CODING_AGENT_DIR ?? "", "extensions", "provider-owner.ts");
	const keys = ["seen", "faux", "registered"].map((name) => Symbol.for(`trdel:owner-${name}`));
	const seen = new Set<string>();
	Reflect.set(globalThis, Symbol.for("trdel:owner-seen"), seen);
	Reflect.set(globalThis, Symbol.for("trdel:owner-faux"), faux);
	mkdirSync(dirname(owner), { recursive: true });
	writeFileSync(
		owner,
		`export default function providerOwner(pi) {
	pi.on("before_agent_start", (_event, ctx) => {
		globalThis[Symbol.for("trdel:owner-seen")].add(ctx.sessionManager.getSessionId());
	});
	if (globalThis[Symbol.for("trdel:owner-registered")]) return;
	globalThis[Symbol.for("trdel:owner-registered")] = true;
	const faux = globalThis[Symbol.for("trdel:owner-faux")];
	pi.registerProvider("owned", {
		api: faux.api,
		baseUrl: "http://owned.local",
		apiKey: "owned",
		streamSimple: (model, context, options) => faux.streamSimple(model, context, options),
		models: [{ id: "owned", name: "owned", api: faux.api, reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }],
	});
}
`,
	);
	const sessionIds: SessionId[] = [];
	try {
		const first = await createSession({
			cwd: tmpDir("trdel-owner-"),
			workspaceId: testWorkspaceId("ws-owner"),
		});
		const second = await createSession({
			cwd: tmpDir("trdel-owner-"),
			workspaceId: testWorkspaceId("ws-owner"),
		});
		sessionIds.push(first.sessionId, second.sessionId);
		const ownerPaths = liveParentContext(first.sessionId)?.providerExtensionPaths?.("owned");
		expect(ownerPaths).toHaveLength(1);
		expect(liveParentContext(second.sessionId)?.providerExtensionPaths?.("owned")).toEqual(
			ownerPaths,
		);
		expect(liveParentContext(second.sessionId)?.providerExtensionPaths?.("faux")).toEqual([]);

		for (const parent of sessionIds) {
			faux.setResponses([
				(_context, options) =>
					seen.has(options?.sessionId ?? "")
						? fauxAssistantMessage("SERVED")
						: fauxAssistantMessage("", { stopReason: "error", errorMessage: "unobserved session" }),
			]);
			const child = await delegationServiceFor(testWorkspaceId("ws-owner")).createChild({
				parent,
				visibility: "hidden",
				info: { createdBy: "tool:Agent", roleName: "worker", roleSource: "builtin" },
				session: {
					systemPrompt: "You are a test worker.",
					model: { provider: "owned", id: "owned" },
				},
			});
			expect((await child.runQueued("Go.")).finalText).toBe("SERVED");
		}

		rmSync(owner);
		const unowned = await createSession({
			cwd: tmpDir("trdel-owner-"),
			workspaceId: testWorkspaceId("ws-owner"),
		});
		sessionIds.push(unowned.sessionId);
		expect(liveParentContext(unowned.sessionId)?.providerExtensionPaths?.("owned")).toEqual([]);
	} finally {
		for (const sessionId of sessionIds) await removeSession(sessionId);
		rmSync(owner, { force: true });
		baseRuntime.unregisterProvider("owned");
		for (const key of keys) Reflect.deleteProperty(globalThis, key);
	}
});

test("the host concurrency resolver binds new services and live-resizes only the refreshed workspace", () => {
	const limits: Record<string, number> = { "ws-limit-a": 2, "ws-limit-b": 5 };
	const resolved: string[] = [];
	setSubagentConcurrencyResolver((workspaceId) => {
		resolved.push(workspaceId);
		return limits[workspaceId] ?? 4;
	});
	try {
		const a = delegationServiceFor(testWorkspaceId("ws-limit-a"));
		const b = delegationServiceFor(testWorkspaceId("ws-limit-b"));
		expect(resolved).toEqual(["ws-limit-a", "ws-limit-b"]);
		const applied: Array<[string, number]> = [];
		a.setMaxConcurrentPerParent = (slots) => applied.push(["ws-limit-a", slots]);
		b.setMaxConcurrentPerParent = (slots) => applied.push(["ws-limit-b", slots]);

		limits["ws-limit-a"] = 9;
		refreshSubagentConcurrency(testWorkspaceId("ws-limit-a"));
		expect(applied).toEqual([["ws-limit-a", 9]]);

		limits["ws-limit-b"] = 1;
		refreshSubagentConcurrency();
		expect(applied).toContainEqual(["ws-limit-a", 9]);
		expect(applied).toContainEqual(["ws-limit-b", 1]);
	} finally {
		setSubagentConcurrencyResolver(null);
	}
});

test("a transcript read accepts canonical dotted session ids", () => {
	expect(() =>
		readChildTranscript(
			testWorkspaceId("ws"),
			testSessionId("parent..session"),
			testSessionId("child..session"),
		),
	).toThrow("No transcript found");
});

test("the completion tag mirrors pi-subagents'", () => {
	expect(SUBAGENT_COMPLETION_CUSTOM_TYPE).toBe(SUBAGENT_COMPLETION_MESSAGE);
});
