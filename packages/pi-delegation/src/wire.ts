import type { StopReason as PiStopReason } from "@earendil-works/pi-ai";
import { ModelThinkingLevelSchema } from "@earendil-works/pi-ai/providers/model-schema";
import { arr, bool, lit, num, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import type { Same } from "type-tie";

/** pi-ai's `StopReason`, which pi-ai ships only as a type. */
export const STOP_REASONS = [
	"pending",
	"stop",
	"length",
	"toolUse",
	"error",
	"aborted",
	"deferred",
] as const;
export const StopReason = oneOf(STOP_REASONS);
export type StopReason = Same<Static<typeof StopReason>, PiStopReason>;

export const RUN_STATUSES = ["completed", "error", "aborted"] as const;
export const RunStatus = oneOf(RUN_STATUSES);
export type RunStatus = Static<typeof RunStatus>;

export const RUN_LIFECYCLE_STATUSES = ["queued", "running", ...RUN_STATUSES] as const;
export const RunLifecycleStatus = oneOf(RUN_LIFECYCLE_STATUSES);
export type RunLifecycleStatus = Static<typeof RunLifecycleStatus>;

/** A delegated run as a tool result's `details` reports it. */
export const DELEGATION_RUN_FIELDS = {
	childSessionId: str(),
	roleName: opt(str()),
	roleSource: opt(str()),
	task: str(),
	status: RunLifecycleStatus,
	model: opt(str()),
	thinkingLevel: opt(ModelThinkingLevelSchema),
	usage: obj(
		{
			input: num(),
			output: num(),
			cacheRead: num(),
			cacheWrite: num(),
			cost: num(),
			turns: num(),
			contextTokens: num(),
		},
		{ open: true },
	),
	durationMs: num(),
	activity: opt(str()),
	abortReason: opt(str()),
};

/** A child's session configuration, as a resource birth record saves it. */
export const SessionOptions = obj(
	{
		model: opt(obj({ provider: str({ minLength: 1 }), id: str({ minLength: 1 }) }, { open: true })),
		thinkingLevel: opt(ModelThinkingLevelSchema),
		tools: opt(arr(str())),
		excludeTools: opt(arr(str())),
		systemPrompt: opt(str()),
		contextFiles: opt(bool()),
		skills: opt(arr(str())),
		extensions: opt(bool()),
	},
	{ open: true },
);
export type SessionOptions = Static<typeof SessionOptions>;

/** Who created a child and in which role. */
export const ChildInfo = obj({
	createdBy: str({ minLength: 1 }),
	roleName: opt(str()),
	roleSource: opt(str()),
	detached: opt(bool()),
});
export type ChildInfo = Static<typeof ChildInfo>;

/** A resource child's spawn record without its file path: what an owner saves to reopen the child. */
export const ResourceChildBirth = obj({
	sessionId: str(),
	resourceId: str(),
	scope: str(),
	originKind: oneOf(["fresh", "fork"]),
	entryId: opt(str({ minLength: 1 })),
	info: ChildInfo,
	interactive: lit(false),
	visibility: lit("hidden"),
	createdAt: str(),
});
