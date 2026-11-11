import { arr, opt, type Static, str } from "@earendil-works/pi-schema";
import { WorkspaceId } from "./ids";
import { wireObj } from "./wire";

export const SpecGraphNode = wireObj({
	id: str(),
	type: str(),
	title: str(),
	status: opt(str()),
	path: str(),
	parent: opt(str()),
	dependsOn: arr(str()),
	references: arr(str()),
	implements: arr(str()),
	tags: arr(str()),
});
export type SpecGraphNode = Static<typeof SpecGraphNode>;

export const SpecGraphSnapshot = wireObj({ nodes: arr(SpecGraphNode) });
export type SpecGraphSnapshot = Static<typeof SpecGraphSnapshot>;

export const SPEC_METHODS = {
	"spec.graph": { params: wireObj({ workspaceId: WorkspaceId }), result: SpecGraphSnapshot },
};
