import type { ToolInputs } from "@thinkrail/contracts";
import { strArg } from "@thinkrail/extension-api/web";
import { projectRelativePath } from "@/lib";
import { registerToolRenderer } from "../toolRegistry";
import { BashCard } from "./BashCard";
import { EditCard } from "./EditCard";
import { ReadCard } from "./ReadCard";
import { RequestReviewCard, requestReviewSummary } from "./RequestReviewCard";
import { ResolveCommentCard } from "./ResolveCommentCard";
import { SpecToolCard, specToolSummary } from "./SpecToolCard";
import "./mcp/register";
import "./subagent/register";
import "./web/register";
import { WriteCard } from "./WriteCard";

registerToolRenderer("bash", BashCard, {
	summary: ({ args }) => strArg<ToolInputs["bash"]>(args, "command"),
});
registerToolRenderer("read", ReadCard, {
	summary: ({ args, workspaceRoot }) =>
		projectRelativePath(strArg<ToolInputs["read"]>(args, "path"), workspaceRoot),
});
registerToolRenderer("edit", EditCard, {
	summary: ({ args, workspaceRoot }) =>
		projectRelativePath(strArg<ToolInputs["edit"]>(args, "path"), workspaceRoot),
});
registerToolRenderer("write", WriteCard, {
	summary: ({ args, workspaceRoot }) =>
		projectRelativePath(strArg<ToolInputs["write"]>(args, "path"), workspaceRoot),
});

for (const toolName of [
	"spec_grep",
	"spec_get",
	"spec_graph",
	"spec_create",
	"spec_update",
	"spec_delete",
	"spec_validate",
]) {
	registerToolRenderer(toolName, SpecToolCard, { summary: specToolSummary });
}

registerToolRenderer("resolve_comment", ResolveCommentCard, {
	summary: ({ args }) => strArg<ToolInputs["resolve_comment"]>(args, "commentId"),
});

registerToolRenderer("request_review", RequestReviewCard, {
	summary: requestReviewSummary,
	prominence: "primary",
	defaultExpanded: true,
});
