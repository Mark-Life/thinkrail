import type { Static } from "@earendil-works/pi-schema";
import { BACKGROUND_COMMAND_METHODS } from "./backgroundCommand";
import { CHANGE_METHODS } from "./change";
import { CLIENT_METHODS } from "./client";
import { CUSTOM_ENDPOINT_METHODS } from "./customEndpoint";
import { DIALOG_METHODS } from "./dialog";
import { EDITOR_METHODS } from "./editor";
import { ENVIRONMENT_METHODS } from "./environment";
import { EXTENSION_METHODS } from "./extension";
import { FEEDBACK_METHODS } from "./feedback";
import { FONTS_METHODS } from "./fonts";
import { FS_METHODS } from "./fs";
import { GIT_METHODS } from "./git";
import { GITHUB_METHODS } from "./github";
import { HISTORY_METHODS } from "./history";
import { HOST_METHODS } from "./host";
import { LOCALES_METHODS } from "./locales";
import { MCP_METHODS } from "./mcp";
import { MODEL_METHODS } from "./model";
import { PACKAGES_METHODS } from "./packages";
import { PR_METHODS } from "./pr";
import { PROJECT_METHODS } from "./project";
import { PROVIDER_METHODS } from "./provider";
import { REVIEW_METHODS } from "./review";
import { SEARCH_METHODS } from "./search";
import { SESSION_METHODS } from "./session";
import { SETTINGS_METHODS } from "./settings";
import { SKILL_METHODS } from "./skill";
import { SPEC_METHODS } from "./spec";
import { SPEECH_METHODS } from "./speech";
import { SUBAGENT_METHODS } from "./subagent";
import { TEMPLATE_METHODS } from "./template";
import { TERMINAL_METHODS } from "./terminal";
import { THEMES_METHODS } from "./themes";
import { TODO_METHODS } from "./todo";
import { WORKSPACE_METHODS } from "./workspace";

/** Params and result schemas of each WS method. */
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
	...PACKAGES_METHODS,
	...FONTS_METHODS,
	...SPEECH_METHODS,
	...FEEDBACK_METHODS,
	...THEMES_METHODS,
	...LOCALES_METHODS,
	...ENVIRONMENT_METHODS,
	...SKILL_METHODS,
	...SETTINGS_METHODS,
	...HOST_METHODS,
	...HISTORY_METHODS,
	...SEARCH_METHODS,
	...EXTENSION_METHODS,
	...DIALOG_METHODS,
	...CLIENT_METHODS,
};

type WsMethodSchemas = typeof WS_METHOD_SCHEMAS;

/** The `WsMethodMap` entries derived from `WS_METHOD_SCHEMAS`. */
export type WsSchemaMethodMap = {
	[M in keyof WsMethodSchemas]: {
		params: Static<WsMethodSchemas[M]["params"]>;
		result: Static<WsMethodSchemas[M]["result"]>;
	};
};
