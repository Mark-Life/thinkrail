import { createSubagentsExtension } from "./src/extension";

export type { CompletionDelivery } from "pi-background-commands/wire";
export { BUILTIN_AGENTS } from "./src/builtins";
export {
	type AgentDefinition,
	type DiscoverOptions,
	discoverAgentDefinitions,
	parseAgentDefinition,
} from "./src/definitions";
export {
	createSubagents,
	createSubagentsExtension,
	type Subagents,
	type SubagentsExtensionOptions,
} from "./src/extension";
export {
	buildChildSystemPrompt,
	RECURSION_GUARD_TOOLS,
	resolveModelRef,
	type SpawnMapping,
	toSpawnMapping,
} from "./src/mapping";
export { SUBAGENT_COMPLETION_MESSAGE, type SubagentCompletionDetails } from "./src/wire";

export default createSubagentsExtension();
