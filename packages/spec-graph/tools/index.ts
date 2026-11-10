import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type { SpecCreateInput } from "./create.ts";
export type { SpecDeleteInput } from "./delete.ts";
export type { SpecGetInput } from "./get.ts";
export type { SpecGraphInput } from "./graph.ts";
export type { SpecGrepInput } from "./grep.ts";
export type { SpecUpdateInput } from "./update.ts";

import { registerSpecCreate } from "./create.ts";
import { registerSpecDelete } from "./delete.ts";
import { registerSpecGet } from "./get.ts";
import { registerSpecGraph } from "./graph.ts";
import { registerSpecGrep } from "./grep.ts";
import { registerSpecUpdate } from "./update.ts";
import { registerSpecValidate } from "./validate.ts";

export function registerSpecTools(pi: ExtensionAPI): void {
	registerSpecGrep(pi);
	registerSpecGet(pi);
	registerSpecGraph(pi);
	registerSpecCreate(pi);
	registerSpecUpdate(pi);
	registerSpecDelete(pi);
	registerSpecValidate(pi);
}
