import type {
	BashToolInput,
	EditToolInput,
	ReadToolInput,
	WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import type { Same, ToolInputs } from "@thinkrail/contracts";
import type { BackgroundCommandToolArgs } from "pi-background-commands";
import type {
	SpecCreateInput,
	SpecDeleteInput,
	SpecGetInput,
	SpecGraphInput,
	SpecGrepInput,
	SpecUpdateInput,
} from "pi-spec-graph";
import type { AgentToolInput, GetSubagentResultInput } from "pi-subagents";
import type { Static } from "typebox";
import type { ResolveCommentSchema } from "./reviewTool";

type ResolveCommentInput = Static<typeof ResolveCommentSchema>;

/**
 * Each `ToolInputs` entry is exactly the fields it names of its owner's input type. A `Pick` of a field the
 * owner renamed or dropped fails `tsc`, and so does a changed type or optionality.
 */
export type ToolInputTies = [
	Same<ToolInputs["read"], Pick<ReadToolInput, "path" | "offset" | "limit">>,
	Same<ToolInputs["write"], Pick<WriteToolInput, "path" | "content">>,
	Same<ToolInputs["edit"], Pick<EditToolInput, "path" | "edits">>,
	Same<ToolInputs["bash"], Pick<BashToolInput, "command">>,
	Same<ToolInputs["spec_grep"], Pick<SpecGrepInput, "pattern">>,
	Same<ToolInputs["spec_graph"], Pick<SpecGraphInput, "root">>,
	Same<ToolInputs["spec_create"], Pick<SpecCreateInput, "path">>,
	Same<ToolInputs["spec_get"], Pick<SpecGetInput, "id">>,
	Same<ToolInputs["spec_update"], Pick<SpecUpdateInput, "id">>,
	Same<ToolInputs["spec_delete"], Pick<SpecDeleteInput, "id">>,
	Same<ToolInputs["resolve_comment"], Pick<ResolveCommentInput, "commentId" | "note">>,
	Same<ToolInputs["Agent"], Pick<AgentToolInput, "subagent_type" | "task" | "run_in_background">>,
	Same<ToolInputs["get_subagent_result"], Pick<GetSubagentResultInput, "session_id">>,
	Same<ToolInputs["background_command"], Pick<BackgroundCommandToolArgs, "action">>,
];
