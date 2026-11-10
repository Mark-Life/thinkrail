import { compile, map, unknown } from "@earendil-works/pi-schema";

/** Any non-null, non-array value, for a reader that checks its fields one by one. */
export const JsonObject = compile(map(unknown()));
