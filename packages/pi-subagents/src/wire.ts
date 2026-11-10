import { opt, type StaticObject } from "@earendil-works/pi-schema";
import { CompletionDelivery } from "pi-background-commands/wire";
import { DELEGATION_RUN_FIELDS } from "pi-delegation/wire";

export const SUBAGENT_COMPLETION_MESSAGE = "subagent-completion";

export const SUBAGENT_COMPLETION_FIELDS = {
	...DELEGATION_RUN_FIELDS,
	delivery: opt(CompletionDelivery),
};
export type SubagentCompletionDetails = StaticObject<typeof SUBAGENT_COMPLETION_FIELDS>;
