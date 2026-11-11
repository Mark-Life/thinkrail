import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type FrontmatterEdit, SpecUpdateInput, updateFrontmatterText } from "../core/index.ts";
import { errorResult, errorText, getIndex, textResult, toolParameters } from "./shared.ts";

const parameters = toolParameters(SpecUpdateInput);

export function registerSpecUpdate(pi: ExtensionAPI): void {
	pi.registerTool<typeof parameters, { id: string; path: string } | { error: string }>({
		name: "spec_update",
		label: "Spec Update",
		description:
			"Edit a spec's frontmatter only (never its prose): set/overwrite scalar fields, remove fields, and add/remove entries in the list fields (depends-on/references/implements/covers/tags). Comments and any non-dialect fields are preserved. Prose is edited with the write/edit tools.",
		promptSnippet:
			"spec_update — edit a spec's frontmatter only (scalar fields + list entries); never its prose.",
		parameters,
		async execute(_callId, params, _signal, _onUpdate, ctx) {
			const index = getIndex(ctx.cwd);
			const record = index.recordForId(params.id);
			if (!record) return errorResult(`No spec with id "${params.id}".`);

			const { abs, rel: path, content: cachedText } = record;
			const edit: FrontmatterEdit = {
				set: params.set,
				remove: params.remove,
				addList: params.addList,
				removeList: params.removeList,
			};
			const result = updateFrontmatterText(cachedText, edit);
			if ("error" in result) return errorResult(result.error);
			try {
				writeFileSync(abs, result.content, "utf8");
			} catch (err) {
				return errorResult(`Failed to write ${path}: ${errorText(err)}`);
			}
			return textResult(`Updated frontmatter of ${path} (id: ${params.id}).`, {
				id: params.id,
				path,
			});
		},
	});
}
