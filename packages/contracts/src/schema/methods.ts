import type { Static } from "@earendil-works/pi-schema";
import { PROJECT_METHODS } from "./project";

/** Params and result schemas of each WS method that has a runtime form. */
export const WS_METHOD_SCHEMAS = { ...PROJECT_METHODS };

type WsMethodSchemas = typeof WS_METHOD_SCHEMAS;

/** The `WsMethodMap` entries derived from `WS_METHOD_SCHEMAS`. */
export type WsSchemaMethodMap = {
	[M in keyof WsMethodSchemas]: {
		params: Static<WsMethodSchemas[M]["params"]>;
		result: Static<WsMethodSchemas[M]["result"]>;
	};
};
