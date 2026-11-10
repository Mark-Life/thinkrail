/**
 * The tool arguments chat cards read, by tool name: for each tool, the fields a card reads of its input.
 * Each owner types its input with a TypeBox schema that browser code cannot load, so the server program
 * ties every entry with `Same` to a `Pick` of the owner's own type, and a renamed or retyped field fails
 * `tsc` there.
 */
export interface ToolInputs {
	read: { path: string; offset?: number; limit?: number };
	write: { path: string; content: string };
	edit: { path: string; edits: { oldText: string; newText: string }[] };
	bash: { command: string };
	spec_grep: { pattern: string };
	spec_graph: { root: string };
	spec_create: { path: string };
	spec_get: { id: string };
	spec_update: { id: string };
	spec_delete: { id: string };
	resolve_comment: { commentId: string; note?: string };
	Agent: { subagent_type: string; task: string; run_in_background?: boolean };
	get_subagent_result: { session_id: string };
	background_command: { action: "start" | "list" | "output" | "stop" };
}
