import { arr, oneOf, opt, type Schema, type Static, str } from "@earendil-works/pi-schema";
import { ProjectId, WorkspaceId } from "./ids";
import { Ack, wireObj } from "./wire";

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

export type TemplateReadLocation =
	| { workspaceId: WorkspaceId; projectId?: never }
	| { projectId: ProjectId; workspaceId?: never }
	| { workspaceId?: never; projectId?: never };

export const TemplateReadLocation: Schema<TemplateReadLocation> = {
	type: "object",
	properties: { workspaceId: WorkspaceId, projectId: ProjectId },
	not: { required: ["workspaceId", "projectId"] },
};

const TemplateGetParams: Schema<TemplateReadLocation & { name: string; scope?: TemplateScope }> = {
	allOf: [TemplateReadLocation, wireObj({ name: str(), scope: opt(TemplateScope) })],
};

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
