import type {
	BashToolInput,
	EditToolInput,
	ReadToolInput,
	WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import type { Same, ToolInputs } from "@thinkrail/contracts";

/**
 * Each `ToolInputs` entry for a pi built-in tool is exactly the fields it names of pi's input type. A `Pick`
 * of a field pi renamed or dropped fails `tsc`, and so does a changed type or optionality.
 */
export type ToolInputTies = [
	Same<ToolInputs["read"], Pick<ReadToolInput, "path" | "offset" | "limit">>,
	Same<ToolInputs["write"], Pick<WriteToolInput, "path" | "content">>,
	Same<ToolInputs["edit"], Pick<EditToolInput, "path" | "edits">>,
	Same<ToolInputs["bash"], Pick<BashToolInput, "command">>,
];
