import { arr, oneOf, opt, type Static, str } from "@earendil-works/pi-schema";
import { ProjectId, WorkspaceId } from "./ids";
import { Ack, narrowed, wireObj } from "./wire";

export const TemplateScope = oneOf(["global", "project"]);
export type TemplateScope = Static<typeof TemplateScope>;

const TEMPLATE_INFO_FIELDS = {
	name: str(),
	description: opt(str()),
	argumentHint: opt(str()),
	scope: TemplateScope,
	filePath: str(),
};

export const TemplateInfo = wireObj(TEMPLATE_INFO_FIELDS);
export type TemplateInfo = Static<typeof TemplateInfo>;

export const Template = wireObj({ ...TEMPLATE_INFO_FIELDS, content: str() });
export type Template = Static<typeof Template>;

const TEMPLATE_LOCATION_FIELDS = { workspaceId: opt(WorkspaceId), projectId: opt(ProjectId) };
/** A template is read from a workspace, a project, or neither (global only), never both. */
const ONE_LOCATION = { not: { required: ["workspaceId", "projectId"] } };

export const TemplateReadLocation = narrowed(wireObj(TEMPLATE_LOCATION_FIELDS), ONE_LOCATION);
export type TemplateReadLocation = Static<typeof TemplateReadLocation>;

const TemplateGetParams = narrowed(
	wireObj({ ...TEMPLATE_LOCATION_FIELDS, name: str(), scope: opt(TemplateScope) }),
	ONE_LOCATION,
);

export const TEMPLATE_METHODS = {
	"template.list": {
		params: TemplateReadLocation,
		result: wireObj({ templates: arr(TemplateInfo) }),
	},
	"template.get": { params: TemplateGetParams, result: Template },
	"template.save": {
		params: wireObj({
			workspaceId: opt(WorkspaceId),
			scope: TemplateScope,
			name: str(),
			content: str(),
		}),
		result: Template,
	},
	"template.delete": {
		params: wireObj({ workspaceId: opt(WorkspaceId), scope: TemplateScope, name: str() }),
		result: Ack,
	},
};
