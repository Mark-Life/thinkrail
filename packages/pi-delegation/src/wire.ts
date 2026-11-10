import { ModelThinkingLevelSchema } from "@earendil-works/pi-ai/providers/model-schema";
import { arr, bool, num, obj, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";

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
