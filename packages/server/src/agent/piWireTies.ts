import type { Message } from "@earendil-works/pi-ai";
import type {
	AgentSessionEvent,
	CompactionResult,
	DefaultPackageManager,
	ExtensionUIContext,
	PackageManager,
	ContextUsage as PiContextUsage,
	SessionStats as PiSessionStats,
	SlashCommandInfo as PiSlashCommandInfo,
	ResolvedPaths,
	SessionEntry,
	SettingsManager,
	SourceInfo,
} from "@earendil-works/pi-coding-agent";
import type {
	CompactionEndResult,
	ContextUsage,
	ExtUiRequest,
	PiEvent,
	PiForwardedEvent,
	PiPackageResourceType,
	PiPackageScope,
	PiPackageSourceKind,
	PiProjectedEventType,
	ProviderWarning,
	Same,
	SessionEntryType,
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
import type { AgentMessage } from "./piTypes";

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

/** The roles pi-coding-agent adds to pi-ai's `Message`: a browser build types them only through `WireAgentMessage`. */
type AddedRole = Exclude<AgentMessage["role"], Message["role"]>;
type ToolPayloadField = "args" | "partialResult" | "result";
type Depth = [never, 0, 1, 2, 3, 4, 5, 6];
/**
 * `true` when `T` holds a message with an added role within six levels. `any` holds nothing, and a pi-ai
 * `Message` is a leaf: its body types are pi-ai's own.
 */
type CarriesAddedMessage<T, D extends number = 7> = [D] extends [never]
	? never
	: 0 extends 1 & T
		? never
		: T extends { role: AddedRole }
			? true
			: T extends Message | ((...args: never) => unknown)
				? never
				: T extends readonly (infer I)[]
					? CarriesAddedMessage<I, Depth[D]>
					: T extends object
						? { [K in keyof T]-?: CarriesAddedMessage<T[K], Depth[D]> }[keyof T]
						: never;
/** The `type.key` of every event field outside `message`/`messages` that carries an added-role message. */
export type AddedMessageFields<E> = E extends { type: string }
	? {
			[K in keyof E]-?: K extends "message" | "messages" | "type"
				? never
				: E extends { type: `tool_execution_${string}` }
					? K extends ToolPayloadField
						? never
						: [CarriesAddedMessage<E[K]>] extends [never]
							? never
							: `${E["type"]}.${K & string}`
					: [CarriesAddedMessage<E[K]>] extends [never]
						? never
						: `${E["type"]}.${K & string}`;
		}[keyof E]
	: never;
export type ForwardedNestedMessageTie = Same<AddedMessageFields<PiForwardedSource>, never>;
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
export type SessionEntryTypeTie = Same<SessionEntryType, SessionEntry["type"]>;

type ExtUi<K extends ExtUiRequest["kind"]> = Extract<ExtUiRequest, { kind: K }>;
type SetWidgetOverloads = ExtensionUIContext["setWidget"] extends {
	(...args: infer A): void;
	(...args: infer B): void;
}
	? A | B
	: never;
/** The `setWidget` overload that takes lines of text, picked by its content parameter. */
type SetWidgetLines = Extract<SetWidgetOverloads, [string, string[] | undefined, ...unknown[]]>;
export type NotifyLevelTie = Same<
	ExtUi<"notify">["level"],
	NonNullable<Parameters<ExtensionUIContext["notify"]>[1]>
>;
export type SetWidgetContentTie = Same<
	NonNullable<ExtUi<"setWidget">["content"]>,
	NonNullable<SetWidgetLines[1]>
>;

export type PiPackageScopeTie = Same<
	PiPackageScope,
	ReturnType<PackageManager["listConfiguredPackages"]>[number]["scope"]
>;
export type PiPackageResourceTypeTie = Same<
	PiPackageResourceType,
	Exclude<keyof ResolvedPaths, "themes" | "installFailures">
>;
export type PiPackageSourceKindTie = Same<
	Exclude<PiPackageSourceKind, "local">,
	Awaited<ReturnType<DefaultPackageManager["checkForAvailableUpdates"]>>[number]["type"]
>;
export type ProviderWarningTie = Same<
	ProviderWarning,
	keyof ReturnType<SettingsManager["getWarnings"]>
>;
