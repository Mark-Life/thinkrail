import { rmSync } from "node:fs";
import { join } from "node:path";
import {
	buildSessionContext,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { SessionId, WorkspaceId } from "@thinkrail/contracts";
import {
	type DelegationRunStatus,
	parseSessionId,
	type ThinkingLevel,
	type TranscriptMessage,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import {
	type ChildHandle,
	createDelegationService,
	type DelegationService,
	delegationSessionDir,
	deriveChildSessionFile,
	type RunStatus,
} from "pi-delegation";
import { createSubagents, type Subagents } from "pi-subagents";
import { dataDir } from "../persistence";
import {
	buildSessionSettings,
	canUseSessionResources,
	liveParentContext,
	recordSessionUsage,
	scheduleSessionStatePublish,
} from "./agentSessionManager";
import { archiveSubagentRun, publishSessionResourcesChanged } from "./chatResources";
import { childBaseExtensionFactories, childExtensionFactories } from "./extensions";
import { getPiRuntime } from "./piRuntime";
import { requireSessionId } from "./requireSessionId";
import {
	createRunUsageRecorder,
	reconcileSubagentUsage,
	SUBAGENT_USAGE_KIND,
	type SubagentUsage,
} from "./subagentUsage";
import { transcriptMessages } from "./transcriptMessages";

export function delegationRootDir(): string {
	return join(dataDir(), "delegation");
}

const services = new Map<WorkspaceId, DelegationService>();
let concurrencyResolver: ((workspaceId: WorkspaceId) => number) | null = null;

export function setSubagentConcurrencyResolver(
	resolver: ((workspaceId: WorkspaceId) => number) | null,
): void {
	concurrencyResolver = resolver;
}

export function refreshSubagentConcurrency(workspaceId?: WorkspaceId): void {
	if (!concurrencyResolver) return;
	for (const [id, service] of services) {
		if (workspaceId === undefined || id === workspaceId) {
			service.setMaxConcurrentPerParent(concurrencyResolver(id));
		}
	}
}

function recordSubagentUsage(parentSessionId: SessionId, usage: SubagentUsage): boolean {
	return recordSessionUsage(parentSessionId, {
		kind: SUBAGENT_USAGE_KIND,
		provider: usage.provider,
		model: usage.model,
		usage: usage.usage,
		note: usage.childSessionId,
	});
}

const runUsage = createRunUsageRecorder(recordSubagentUsage);

export function reconcileSessionSubagentUsage(
	workspaceId: WorkspaceId,
	parentSessionId: SessionId,
	entries: () => readonly SessionEntry[] | undefined,
): Promise<void> {
	return reconcileSubagentUsage({
		dir: delegationSessionDir(delegationRootDir(), workspaceId, parentSessionId),
		entries,
		isLive: (childSessionId) => {
			const status = services.get(workspaceId)?.findChild(childSessionId)?.snapshot?.status;
			return status === "queued" || status === "running";
		},
		record: (usage) => recordSubagentUsage(parentSessionId, usage),
	});
}

function runIdsOf(event: { parentSessionId: string; sessionId: string }) {
	const parent = parseSessionId(event.parentSessionId);
	const child = parseSessionId(event.sessionId);
	return parent === null || child === null ? null : { parent, child };
}

export function delegationServiceFor(workspaceId: WorkspaceId): DelegationService {
	let service = services.get(workspaceId);
	if (!service) {
		const maxConcurrentPerParent = concurrencyResolver?.(workspaceId);
		const created = createDelegationService({
			...(maxConcurrentPerParent === undefined ? {} : { maxConcurrentPerParent }),
			resolveParent: (rawSessionId) => {
				const sessionId = parseSessionId(rawSessionId);
				return sessionId !== null && canUseSessionResources(sessionId, workspaceId)
					? liveParentContext(sessionId)
					: undefined;
			},
			delegationRoot: delegationRootDir(),
			scope: workspaceId,
			modelRuntime: getPiRuntime,
			childBaseExtensionFactories: childBaseExtensionFactories(),
			childExtensionFactories: childExtensionFactories(),
			buildChildSettings: buildSessionSettings,
		});
		created.onLifecycle((event) => {
			if (event.type === "run-progress") {
				const run = runIdsOf(event);
				if (run) runUsage.progress(run.parent, run.child, event.details);
				return;
			}
			if (event.type === "run-terminal") {
				const run = runIdsOf(event);
				if (run) runUsage.terminal(run.parent, run.child, event.outcome.details);
			}
			if (services.get(workspaceId) === created) archiveSubagentRun(workspaceId, created, event);
			const parentSessionId = parseSessionId(
				event.type === "child-created" ? event.record.parentSessionId : event.parentSessionId,
			);
			if (parentSessionId !== null && canUseSessionResources(parentSessionId, workspaceId)) {
				publishSessionResourcesChanged(workspaceId, parentSessionId);
				scheduleSessionStatePublish(parentSessionId);
			}
		});
		services.set(workspaceId, created);
		service = created;
	}
	return service;
}

export function subagentsFor(
	workspaceId: WorkspaceId,
	isEnabled: () => boolean,
	canDeliverCompletion: () => boolean,
): Subagents {
	return createSubagents({
		service: delegationServiceFor(workspaceId),
		delegationRoot: delegationRootDir(),
		scope: workspaceId,
		isEnabled,
		canDeliverCompletion,
	});
}

function liveSessionChildren(workspaceId: WorkspaceId, parentSessionId: SessionId): ChildHandle[] {
	return (services.get(workspaceId)?.childrenOf(parentSessionId) ?? []).filter(
		(child) =>
			child.record.scope === workspaceId &&
			child.record.parentSessionId === parentSessionId &&
			(child.snapshot?.status === "queued" || child.snapshot?.status === "running"),
	);
}

export function hasLiveSessionChildren(
	workspaceId: WorkspaceId,
	parentSessionId: SessionId,
): boolean {
	return liveSessionChildren(workspaceId, parentSessionId).length > 0;
}

/** Cancellation lands synchronously; `settled` resolves once every child's run has actually ended. */
export function stopSessionChildren(
	workspaceId: WorkspaceId,
	parentSessionId: SessionId,
	reason: string,
): { stopped: number; settled: Promise<void> } {
	const children = liveSessionChildren(workspaceId, parentSessionId);
	const settled = Promise.allSettled(
		children.map((child) => child.abort(reason).catch(() => child.dispose())),
	).then(() => {});
	return { stopped: children.length, settled };
}

export const INTERRUPTED_ABORT_REASON = "interrupted";

export async function disposeSessionChildren(
	workspaceId: WorkspaceId,
	parentSessionId: SessionId,
): Promise<void> {
	const service = services.get(workspaceId);
	if (!service) return;
	for (const child of service.childrenOf(parentSessionId))
		void child.abort(INTERRUPTED_ABORT_REASON).catch(() => {});
	await service.disposeChildrenOf(parentSessionId);
}

export function removeWorkspaceDelegation(workspaceId: WorkspaceId): void {
	services.delete(workspaceId);
	rmSync(join(delegationRootDir(), workspaceId), { recursive: true, force: true });
}

export function readChildTranscript(
	workspaceId: WorkspaceId,
	parentSessionId: SessionId,
	childSessionId: SessionId,
): { messages: TranscriptMessage[]; status?: DelegationRunStatus } {
	const path = deriveChildSessionFile(
		delegationRootDir(),
		workspaceId,
		parentSessionId,
		childSessionId,
	);
	const child = services.get(workspaceId)?.findChild(childSessionId);
	const ownedChild = child?.record.parentSessionId === parentSessionId ? child : undefined;
	if (!path) {
		if (ownedChild) return { messages: [], status: ownedChild.snapshot?.status ?? "queued" };
		throw new CodedError(
			"SUBAGENT_TRANSCRIPT_NOT_FOUND",
			`No transcript found for subagent session ${childSessionId}`,
		);
	}
	const sessionManager = SessionManager.open(path);
	const messages = transcriptMessages(buildSessionContext(sessionManager.getEntries()).messages);
	const status = ownedChild?.snapshot?.status;
	return { messages, ...(status !== undefined ? { status } : {}) };
}

export interface ReviewSubagentRun {
	childSessionId: SessionId;
	status: RunStatus;
	finalText?: string;
}

/**
 * Spawn the plan-review subagent as a hidden, ephemeral delegation child (V1: hidden + fresh + explicit
 * session), await its run, and dispose it. The child runs with OUR reviewer role (systemPrompt + tool set)
 * plus the reviewer profile — project context files + child extensions (spec tools) — so it follows
 * repository guidance, and returns its final text; the host parses the structured verdict from it.
 * See submodule-server-host-plan-review.
 */
export async function runReviewSubagent(
	workspaceId: WorkspaceId,
	parentSessionId: SessionId,
	task: string,
	role: {
		systemPrompt: string;
		tools: string[];
		model?: { provider: string; id: string };
		thinkingLevel?: ThinkingLevel;
	},
	signal?: AbortSignal,
): Promise<ReviewSubagentRun> {
	const child = await delegationServiceFor(workspaceId).createChild({
		parent: parentSessionId,
		info: { createdBy: "tool:request_review", roleName: "plan-reviewer" },
		visibility: "hidden",
		session: {
			systemPrompt: role.systemPrompt,
			tools: role.tools,
			extensions: true,
			contextFiles: true,
			...(role.model ? { model: role.model } : {}),
			...(role.thinkingLevel ? { thinkingLevel: role.thinkingLevel } : {}),
		},
	});
	try {
		const childSessionId = requireSessionId(child.sessionId);
		const outcome = await child.runQueued(task, signal ? { signal } : {});
		return {
			childSessionId,
			status: outcome.status,
			...(outcome.finalText !== undefined ? { finalText: outcome.finalText } : {}),
		};
	} finally {
		await child.dispose().catch(() => {});
	}
}
