import type {
	ContextUsage as PiContextUsage,
	SessionStats as PiSessionStats,
	SlashCommandInfo as PiSlashCommandInfo,
	SourceInfo,
} from "@earendil-works/pi-coding-agent";
import type {
	AgentMessage,
	ContextUsage,
	Same,
	SessionStats,
	SlashCommandInfo,
	SlashCommandSourceInfo,
	WireAgentMessage,
	WireBashExecution,
	WireBranchSummary,
	WireCompactionSummary,
	WireCustomMessage,
} from "@thinkrail/contracts";

type PiMessage<R extends AgentMessage["role"]> = Extract<AgentMessage, { role: R }>;

export type CustomMessageTie = Same<WireCustomMessage, PiMessage<"custom">>;
export type CompactionSummaryTie = Same<WireCompactionSummary, PiMessage<"compactionSummary">>;
export type BranchSummaryTie = Same<WireBranchSummary, PiMessage<"branchSummary">>;
export type BashExecutionTie = Same<WireBashExecution, PiMessage<"bashExecution">>;
export type AgentMessageTie = Same<WireAgentMessage, AgentMessage>;

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
