import { bool, obj, opt, type Static, type StaticObject, str } from "@earendil-works/pi-schema";
import { CompletionDelivery } from "pi-background-commands/wire";
import { DELEGATION_RUN_FIELDS } from "pi-delegation/wire";

export const SUBAGENT_COMPLETION_MESSAGE = "subagent-completion";

export const SUBAGENT_COMPLETION_FIELDS = {
	...DELEGATION_RUN_FIELDS,
	delivery: opt(CompletionDelivery),
};
export type SubagentCompletionDetails = StaticObject<typeof SUBAGENT_COMPLETION_FIELDS>;

/** The `Agent` tool's arguments. */
export const AgentToolInput = obj(
	{
		subagent_type: str({ description: 'The agent definition to run, e.g. "scout"' }),
		task: str({ description: "The complete, self-contained task for the subagent" }),
		model: opt(
			str({
				description:
					'Available model for an unpinned agent: "provider/id" or "provider/id:thinking". Whole-reference matches win; a definition pin ignores this value, and definition thinking overrides a suffix.',
			}),
		),
		run_in_background: opt(
			bool({ description: "Do not wait: return the child session id immediately" }),
		),
	},
	{ open: true },
);
export type AgentToolInput = Static<typeof AgentToolInput>;

/** The `get_subagent_result` tool's arguments. */
export const GetSubagentResultInput = obj(
	{ session_id: str({ description: "The child session id returned by Agent" }) },
	{ open: true },
);
export type GetSubagentResultInput = Static<typeof GetSubagentResultInput>;
