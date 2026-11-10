import type { Static } from "@earendil-works/pi-schema";
import { EXT_UI_CHANNELS } from "./extUi";
import { FEEDBACK_CHANNELS } from "./feedback";
import { FONTS_CHANNELS } from "./fonts";
import { HOST_CHANNELS } from "./host";
import { LOCALES_CHANNELS } from "./locales";
import { MCP_CHANNELS } from "./mcp";
import { PACKAGES_CHANNELS } from "./packages";
import { PROJECT_CHANNELS } from "./project";
import { PROVIDER_CHANNELS } from "./provider";
import { REVIEW_CHANNELS } from "./review";
import { SESSION_CHANNELS } from "./session";
import { SETTINGS_CHANNELS } from "./settings";
import { SPEECH_CHANNELS } from "./speech";
import { TERMINAL_CHANNELS } from "./terminal";
import { THEMES_CHANNELS } from "./themes";
import { WORKSPACE_CHANNELS } from "./workspace";

/** The payload schema of each WS push channel. */
export const WS_CHANNEL_SCHEMAS = {
	...HOST_CHANNELS,
	...PROJECT_CHANNELS,
	...SESSION_CHANNELS,
	...EXT_UI_CHANNELS,
	...PROVIDER_CHANNELS,
	...TERMINAL_CHANNELS,
	...WORKSPACE_CHANNELS,
	...SETTINGS_CHANNELS,
	...FEEDBACK_CHANNELS,
	...REVIEW_CHANNELS,
	...MCP_CHANNELS,
	...LOCALES_CHANNELS,
	...THEMES_CHANNELS,
	...PACKAGES_CHANNELS,
	...FONTS_CHANNELS,
	...SPEECH_CHANNELS,
};

type WsChannelSchemas = typeof WS_CHANNEL_SCHEMAS;

/** The `WsChannelMap` entries derived from `WS_CHANNEL_SCHEMAS`. */
export type WsSchemaChannelMap = {
	[C in keyof WsChannelSchemas]: Static<WsChannelSchemas[C]>;
};
