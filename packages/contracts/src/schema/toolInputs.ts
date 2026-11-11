import type { BackgroundCommandToolArgs } from "pi-background-commands/wire";
import type {
	SpecCreateInput,
	SpecDeleteInput,
	SpecGetInput,
	SpecGraphInput,
	SpecGrepInput,
	SpecUpdateInput,
} from "pi-spec-graph/wire";
import type { AgentToolInput, GetSubagentResultInput } from "pi-subagents/wire";
import type { ResolveCommentInput } from "./review";

/**
 * The tool arguments chat cards read, by tool name: for each tool, the fields a card reads of its input.
 * An in-repo owner's entry picks from the `Static` of its schema. pi-coding-agent's built-in tools type their
 * input with a TypeBox schema browser code cannot load, so the server program ties those four entries with
 * `Same` to a `Pick` of pi's type.
 */
export interface ToolInputs {
	read: { path: string; offset?: number; limit?: number };
	write: { path: string; content: string };
	edit: { path: string; edits: { oldText: string; newText: string }[] };
	bash: { command: string };
	spec_grep: Pick<SpecGrepInput, "pattern">;
	spec_graph: Pick<SpecGraphInput, "root">;
	spec_create: Pick<SpecCreateInput, "path">;
	spec_get: Pick<SpecGetInput, "id">;
	spec_update: Pick<SpecUpdateInput, "id">;
	spec_delete: Pick<SpecDeleteInput, "id">;
	resolve_comment: Pick<ResolveCommentInput, "commentId" | "note">;
	Agent: Pick<AgentToolInput, "subagent_type" | "task" | "run_in_background">;
	get_subagent_result: Pick<GetSubagentResultInput, "session_id">;
	background_command: Pick<BackgroundCommandToolArgs, "action">;
}
