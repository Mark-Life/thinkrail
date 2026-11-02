import type { Static } from "@earendil-works/pi-schema";
import { BACKGROUND_COMMAND_METHODS } from "./backgroundCommand";
import { CUSTOM_ENDPOINT_METHODS } from "./customEndpoint";
import { EDITOR_METHODS } from "./editor";
import { MODEL_METHODS } from "./model";
import { PROJECT_METHODS } from "./project";
import { PROVIDER_METHODS } from "./provider";
import { SESSION_METHODS } from "./session";
import { SUBAGENT_METHODS } from "./subagent";
import { TERMINAL_METHODS } from "./terminal";
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
};

type WsMethodSchemas = typeof WS_METHOD_SCHEMAS;

/** The `WsMethodMap` entries derived from `WS_METHOD_SCHEMAS`. */
export type WsSchemaMethodMap = {
	[M in keyof WsMethodSchemas]: {
		params: Static<WsMethodSchemas[M]["params"]>;
		result: Static<WsMethodSchemas[M]["result"]>;
	};
};
