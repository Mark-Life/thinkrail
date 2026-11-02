import type { Static } from "@earendil-works/pi-schema";
import { BACKGROUND_COMMAND_METHODS } from "./backgroundCommand";
import { CHANGE_METHODS } from "./change";
import { CUSTOM_ENDPOINT_METHODS } from "./customEndpoint";
import { EDITOR_METHODS } from "./editor";
import { FS_METHODS } from "./fs";
import { GIT_METHODS } from "./git";
import { GITHUB_METHODS } from "./github";
import { MCP_METHODS } from "./mcp";
import { MODEL_METHODS } from "./model";
import { PR_METHODS } from "./pr";
import { PROJECT_METHODS } from "./project";
import { PROVIDER_METHODS } from "./provider";
import { REVIEW_METHODS } from "./review";
import { SESSION_METHODS } from "./session";
import { SPEC_METHODS } from "./spec";
import { SUBAGENT_METHODS } from "./subagent";
import { TEMPLATE_METHODS } from "./template";
import { TERMINAL_METHODS } from "./terminal";
import { TODO_METHODS } from "./todo";
import { WORKSPACE_METHODS } from "./workspace";

/** Params and result schemas of each WS method that has a runtime form. */
export const WS_METHOD_SCHEMAS = {
	...PROJECT_METHODS,
	...MODEL_METHODS,
	...CUSTOM_ENDPOINT_METHODS,
	...PROVIDER_METHODS,
	...SESSION_METHODS,
	...SUBAGENT_METHODS,
	...BACKGROUND_COMMAND_METHODS,
	...WORKSPACE_METHODS,
	...EDITOR_METHODS,
	...TERMINAL_METHODS,
	...GIT_METHODS,
	...CHANGE_METHODS,
	...FS_METHODS,
	...SPEC_METHODS,
	...GITHUB_METHODS,
	...PR_METHODS,
	...TODO_METHODS,
	...REVIEW_METHODS,
	...TEMPLATE_METHODS,
	...MCP_METHODS,
};

type WsMethodSchemas = typeof WS_METHOD_SCHEMAS;

/** The `WsMethodMap` entries derived from `WS_METHOD_SCHEMAS`. */
export type WsSchemaMethodMap = {
	[M in keyof WsMethodSchemas]: {
		params: Static<WsMethodSchemas[M]["params"]>;
		result: Static<WsMethodSchemas[M]["result"]>;
	};
};
