import {
	arr,
	bool,
	lit,
	num,
	oneOf,
	opt,
	type Static,
	str,
	union,
} from "@earendil-works/pi-schema";
import { BackgroundCommandSummary } from "./backgroundCommand";
import { SessionId, WorkspaceId } from "./ids";
import { McpServerResourceSummary } from "./mcp";
import { SubagentResourceSummary } from "./subagent";
import { wireObj } from "./wire";

export const ResourceRecord = union([
	wireObj({ kind: lit("command"), summary: BackgroundCommandSummary }),
	wireObj({ kind: lit("subagent"), summary: SubagentResourceSummary }),
]);
export type ResourceRecord = Static<typeof ResourceRecord>;

export const ResourceKind = oneOf(["command", "subagent"]);
export type ResourceKind = Static<typeof ResourceKind>;

export const ResourceTally = wireObj({
	done: num(),
	failed: num(),
	stopped: num(),
	interrupted: num(),
});
export type ResourceTally = Static<typeof ResourceTally>;

export const SessionResourceHistory = wireObj({
	commands: ResourceTally,
	subagents: ResourceTally,
});
export type SessionResourceHistory = Static<typeof SessionResourceHistory>;

export const ResourceHistoryCursor = wireObj({ at: num(), id: str() });
export type ResourceHistoryCursor = Static<typeof ResourceHistoryCursor>;

export const ResourceHistoryPage = union([
	wireObj({ kind: lit("command"), items: arr(BackgroundCommandSummary), hasMore: bool() }),
	wireObj({ kind: lit("subagent"), items: arr(SubagentResourceSummary), hasMore: bool() }),
]);
export type ResourceHistoryPage = Static<typeof ResourceHistoryPage>;

export const SessionResources = wireObj({
	workspaceId: WorkspaceId,
	sessionId: SessionId,
	commands: arr(BackgroundCommandSummary),
	subagents: arr(SubagentResourceSummary),
	/** Absent on hosts without MCP support (`MCP_PROTOCOL_VERSION`). */
	mcpServers: opt(arr(McpServerResourceSummary)),
	/** Every finished record of this chat by outcome; absent before `RESOURCE_HISTORY_PROTOCOL_VERSION`. */
	history: opt(SessionResourceHistory),
});
export type SessionResources = Static<typeof SessionResources>;
