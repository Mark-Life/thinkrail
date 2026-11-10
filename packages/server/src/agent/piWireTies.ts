import type {
	AgentSessionEvent,
	CompactionResult,
	ContextUsage as PiContextUsage,
	SessionStats as PiSessionStats,
	SlashCommandInfo as PiSlashCommandInfo,
	SourceInfo,
} from "@earendil-works/pi-coding-agent";
import type {
	AgentMessage,
	CompactionEndResult,
	ContextUsage,
	DelegationRunDetails,
	DelegationRunStatus,
	PiEvent,
	PiForwardedEvent,
	PiProjectedEventType,
	Same,
	SessionStats,
	SlashCommandInfo,
	SlashCommandSourceInfo,
	WireAgentMessage,
	WireBashExecution,
	WireBranchSummary,
	WireCompactionSummary,
	WireCustomMessage,
	WithWireMessages,
} from "@thinkrail/contracts";
import type { DelegationRunDetails as CoreRunDetails, RunLifecycleStatus } from "pi-delegation";

type PiMessage<R extends AgentMessage["role"]> = Extract<AgentMessage, { role: R }>;
type PiSessionEvent<T extends AgentSessionEvent["type"]> = Extract<AgentSessionEvent, { type: T }>;
type WireEvent<T extends PiEvent["type"]> = Extract<PiEvent, { type: T }>;

export type CustomMessageTie = Same<WireCustomMessage, PiMessage<"custom">>;
export type CompactionSummaryTie = Same<WireCompactionSummary, PiMessage<"compactionSummary">>;
export type BranchSummaryTie = Same<WireBranchSummary, PiMessage<"branchSummary">>;
export type BashExecutionTie = Same<WireBashExecution, PiMessage<"bashExecution">>;
export type AgentMessageTie = Same<WireAgentMessage, AgentMessage>;

type PiForwardedSource = Exclude<AgentSessionEvent, { type: PiProjectedEventType }>;
/** The events whose `K` field is not exactly `V`: `WithWireMessages` rewrites that field on both sides. */
type FieldMismatch<E, K extends PropertyKey, V> = E extends unknown
	? K extends keyof E
		? [E[K]] extends [V]
			? [V] extends [E[K]]
				? never
				: E
			: E
		: never
	: never;

export type PiEventTypeTie = Same<PiEvent["type"], AgentSessionEvent["type"]>;
export type ForwardedEventTie = Same<PiForwardedEvent, WithWireMessages<PiForwardedSource>>;
export type ForwardedMessageTie = Same<
	FieldMismatch<PiForwardedSource, "message", AgentMessage>,
	never
>;
export type ForwardedMessagesTie = Same<
	FieldMismatch<PiForwardedSource, "messages", AgentMessage[]>,
	never
>;
export type QueueUpdateTie = Same<
	Omit<WireEvent<"queue_update">, "hasImages">,
	Omit<PiSessionEvent<"queue_update">, never>
>;
export type CompactionEndTie = Same<
	Omit<WireEvent<"compaction_end">, "result">,
	Omit<PiSessionEvent<"compaction_end">, "result">
>;
export type CompactionEndResultTie = Same<
	CompactionEndResult,
	Pick<CompactionResult, "tokensBefore" | "estimatedTokensAfter">
>;

export type ContextUsageTie = Same<ContextUsage, PiContextUsage>;
export type SessionStatsTie = Same<
	Omit<SessionStats, "sessionId">,
	Pick<PiSessionStats, "totalMessages" | "tokens" | "cost" | "contextUsage">
>;
export type SlashCommandInfoTie = Same<
	Omit<SlashCommandInfo, "sourceInfo">,
	Omit<PiSlashCommandInfo, "sourceInfo">
>;
export type SlashCommandSourceInfoTie = Same<
	SlashCommandSourceInfo,
	Pick<SourceInfo, "path" | "source" | "scope" | "origin" | "baseDir">
>;

export type DelegationRunDetailsTie = Same<DelegationRunDetails, CoreRunDetails>;
export type DelegationRunStatusTie = Same<DelegationRunStatus, RunLifecycleStatus>;
