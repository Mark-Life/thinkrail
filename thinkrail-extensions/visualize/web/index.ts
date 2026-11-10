import { defineWebExtension, listArg, strArg } from "@thinkrail/extension-api/web";
import type { VisualizeParams } from "@thinkrail/pi-visualize/schema";
import { VisualizationCard } from "./VisualizationCard";

export { MermaidView } from "./MermaidView";

export default defineWebExtension({
	name: "visualize",
	toolRenderers: {
		visualize: {
			renderer: VisualizationCard,
			options: {
				prominence: "primary",
				defaultExpanded: true,
				summary: ({ args }, translate) => {
					const title = strArg<VisualizeParams>(args, "title");
					if (title) return title;
					if (strArg<VisualizeParams>(args, "type") === "comparison") {
						const count = listArg<VisualizeParams>(args, "options").length;
						return translate("visualize.summary.comparison", { count });
					}
					if (strArg<VisualizeParams>(args, "type") === "file") {
						const path = strArg<VisualizeParams>(args, "path");
						const before = strArg<VisualizeParams>(args, "before");
						return before && path
							? translate("visualize.summary.fileComparison", { before, path })
							: path || translate("visualize.summary.file");
					}
					return translate("visualize.summary.diagram");
				},
			},
		},
	},
});
