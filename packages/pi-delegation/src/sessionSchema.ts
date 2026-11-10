import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";
import { ModelThinkingLevelSchema } from "@earendil-works/pi-ai/providers/model-schema";
import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import {
	arr,
	bool,
	compile,
	lit,
	map,
	nullable,
	num,
	obj,
	oneOf,
	opt,
	type Properties,
	type Schema,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/pi-schema";
import type { Same } from "type-tie";
import { StopReason } from "./wire";

type Exactly<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;
type Flat<T> = { [K in keyof T]: T[K] };

/**
 * pi's type `T` as a JSON schema checks it: a JSON-valued field (`JsonValue`, `JsonObject`, `object`) is any
 * value or any object, an open string union such as `Api` is `string`, and a key whose value may be
 * `undefined` may be absent, as `JSON.stringify` drops it. Every other field keeps pi's exact type.
 */
type Checked<T> =
	Exactly<T, JsonValue> extends true
		? unknown
		: [Exactly<T, JsonObject>, string] extends [true, keyof T]
			? Record<string, unknown>
			: [Exactly<T, object>, keyof T] extends [true, never]
				? Record<string, unknown>
				: Exactly<T, string> extends true
					? string
					: CheckedMember<T>;
type CheckedMember<T> = T extends readonly (infer Item)[]
	? Checked<Item>[]
	: T extends object
		? Flat<
				{ [K in keyof T as undefined extends T[K] ? never : K]: Checked<T[K]> } & {
					[K in keyof T as undefined extends T[K] ? K : never]?: Checked<Exclude<T[K], undefined>>;
				}
			>
		: T;

/** Unknown keys pass, as in pi's own reader: a field a later pi adds never refuses a file. */
const open = <const P extends Properties>(properties: P) => obj(properties, { open: true });

const text = open({ type: lit("text"), text: str(), textSignature: opt(str()) });
const thinking = open({
	type: lit("thinking"),
	thinking: str(),
	thinkingSignature: opt(str()),
	redacted: opt(bool()),
});
const image = open({ type: lit("image"), data: str(), mimeType: str() });
const toolCall = open({
	type: lit("toolCall"),
	id: str(),
	name: str(),
	arguments: map(unknown()),
	thoughtSignature: opt(str()),
	namespace: opt(str()),
	argumentsError: opt(str()),
});

const UserContent = union([str(), arr(union([text, image]))]);
const AssistantContent = arr(union([text, thinking, toolCall]));
const ToolResultContent = arr(union([text, image]));

const usage = open({
	input: num(),
	output: num(),
	cacheRead: num(),
	cacheWrite: num(),
	cacheWrite1h: opt(num()),
	reasoning: opt(num()),
	totalTokens: num(),
	cost: open({
		input: num(),
		output: num(),
		cacheRead: num(),
		cacheWrite: num(),
		total: num(),
		totalFromProvider: opt(bool()),
	}),
});

const tool = open({
	name: str(),
	description: str(),
	parameters: map(unknown()),
	constrainedSampling: opt(
		union([
			lit(false),
			open({ type: lit("json_schema"), strict: oneOf(["prefer", "require"]) }),
			open({
				type: lit("grammar"),
				variants: open({ openai_lark: opt(str()), openai_regex: opt(str()) }),
			}),
		]),
	),
});

const system = open({
	role: lit("system"),
	content: union([str(), arr(text)]),
	sections: opt(map(nullable(str()))),
	toolsAdded: opt(arr(tool)),
	toolsRemoved: opt(arr(open({ name: str() }))),
	timestamp: num(),
});

const assistant = open({
	role: lit("assistant"),
	content: AssistantContent,
	api: str(),
	provider: str(),
	model: str(),
	responseModel: opt(str()),
	responseId: opt(str()),
	providerThinkingLevel: opt(str()),
	thinkingLevel: opt(ModelThinkingLevelSchema),
	diagnostics: opt(
		arr(
			open({
				type: str(),
				timestamp: num(),
				error: opt(
					open({
						name: opt(str()),
						message: str(),
						stack: opt(str()),
						code: opt(union([str(), num()])),
					}),
				),
				details: opt(map(unknown())),
			}),
		),
	),
	usage,
	stopReason: StopReason,
	deferred: opt(
		open({
			provider: str(),
			modelId: str(),
			api: str(),
			id: str(),
			expiresAt: opt(num()),
			pollAfterMs: opt(num()),
			data: opt(unknown()),
		}),
	),
	errorMessage: opt(str()),
	rawStopReason: opt(str()),
	endTurn: opt(bool()),
	timestamp: num(),
	durationMs: opt(num()),
});

const toolResult = open({
	role: lit("toolResult"),
	toolCallId: str(),
	toolName: str(),
	content: ToolResultContent,
	details: opt(unknown()),
	usage: opt(usage),
	nestedCalls: opt(
		open({
			calls: arr(
				open({
					id: str(),
					name: str(),
					arguments: opt(map(unknown())),
					argumentsBytes: opt(num()),
					status: oneOf(["ok", "error", "unfinished"]),
					durationMs: opt(num()),
					error: opt(str()),
				}),
			),
			complete: bool(),
		}),
	),
	isError: bool(),
	timestamp: num(),
	durationMs: opt(num()),
});

const MESSAGES = {
	system,
	user: open({ role: lit("user"), content: UserContent, timestamp: num() }),
	assistant,
	toolResult,
	bashExecution: open({
		role: lit("bashExecution"),
		command: str(),
		output: str(),
		exitCode: opt(num()),
		cancelled: bool(),
		truncated: bool(),
		fullOutputPath: opt(str()),
		timestamp: num(),
		excludeFromContext: opt(bool()),
	}),
	custom: open({
		role: lit("custom"),
		customType: str(),
		content: UserContent,
		display: bool(),
		details: opt(unknown()),
		timestamp: num(),
	}),
	branchSummary: open({
		role: lit("branchSummary"),
		summary: str(),
		fromId: nullable(str()),
		timestamp: num(),
	}),
	compactionSummary: open({
		role: lit("compactionSummary"),
		summary: str(),
		tokensBefore: num(),
		timestamp: num(),
	}),
} satisfies Record<AgentMessage["role"], Schema>;

const entryId = str({ minLength: 1 });
const ENVELOPE = { id: entryId, parentId: nullable(entryId), timestamp: str() };

const ENTRIES = {
	message: open({ type: lit("message"), ...ENVELOPE, message: union(Object.values(MESSAGES)) }),
	thinking_level_change: open({
		type: lit("thinking_level_change"),
		...ENVELOPE,
		thinkingLevel: str(),
	}),
	model_change: open({ type: lit("model_change"), ...ENVELOPE, provider: str(), modelId: str() }),
	usage: open({
		type: lit("usage"),
		...ENVELOPE,
		kind: str(),
		provider: str(),
		model: str(),
		usage,
		note: opt(str()),
	}),
	compaction: open({
		type: lit("compaction"),
		...ENVELOPE,
		summary: str(),
		firstKeptEntryId: entryId,
		tokensBefore: num(),
		details: opt(unknown()),
		usage: opt(usage),
		fromHook: opt(bool()),
		systemMessage: opt(system),
	}),
	branch_summary: open({
		type: lit("branch_summary"),
		...ENVELOPE,
		fromId: str(),
		summary: str(),
		details: opt(unknown()),
		usage: opt(usage),
		fromHook: opt(bool()),
	}),
	custom: open({ type: lit("custom"), ...ENVELOPE, customType: str(), data: opt(unknown()) }),
	custom_message: open({
		type: lit("custom_message"),
		...ENVELOPE,
		customType: str(),
		content: UserContent,
		details: opt(unknown()),
		display: bool(),
	}),
	context_edit: open({
		type: lit("context_edit"),
		...ENVELOPE,
		targetId: entryId,
		replacement: nullable(open({ content: union([UserContent, AssistantContent]) })),
	}),
	label: open({ type: lit("label"), ...ENVELOPE, targetId: entryId, label: opt(str()) }),
	session_info: open({ type: lit("session_info"), ...ENVELOPE, name: opt(str()) }),
} satisfies Record<SessionEntry["type"], Schema>;

const header = open({
	type: lit("session"),
	version: opt(num()),
	id: entryId,
	timestamp: str(),
	cwd: str(),
	parentSession: opt(str()),
});

type ByRole<M extends { role: string }> = { [R in M["role"]]: Checked<Extract<M, { role: R }>> };
type ByType<E extends { type: string }> = { [T in E["type"]]: Checked<Extract<E, { type: T }>> };
type Statics<S extends Record<string, Schema>> = { [K in keyof S]: Static<S[K]> };

export type MessageTie = Same<Statics<typeof MESSAGES>, ByRole<AgentMessage>>;
export type EntryTie = Same<Statics<typeof ENTRIES>, ByType<SessionEntry>>;
export type HeaderTie = Same<Static<typeof header>, Checked<SessionHeader>>;

/** A yes/no check: the code keeps reading pi's own types, never a schema's static type. */
type Valid = (value: unknown) => boolean;

/** Whether a parsed line has the shape of pi's `SessionHeader`. */
export const validHeader: Valid = compile(header).check;
/** Whether a parsed line has the shape of one of pi's `SessionEntry` members. */
export const validEntry: Valid = compile(union(Object.values(ENTRIES))).check;
/** pi types a recorded thinking level as `string`; delegation replays only levels pi-ai defines. */
export const validThinkingLevel: Valid = compile(ModelThinkingLevelSchema).check;
export const validUserContent: Valid = compile(UserContent).check;
export const validAssistantContent: Valid = compile(AssistantContent).check;
export const validToolResultContent: Valid = compile(ToolResultContent).check;
