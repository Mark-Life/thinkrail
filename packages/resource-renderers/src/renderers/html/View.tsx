import { useT } from "@thinkrail/locales/react";
import { cn } from "@thinkrail/ui/utils";
import { useEffect, useState } from "react";
import type { ResourceViewProps } from "../../registry";
import { HtmlSourceFrame } from "./HtmlSourceFrame";
import { useHtmlMode } from "./useHtmlMode";
import { useHtmlViewport } from "./useHtmlViewport";
import { HtmlPreviewNotice } from "./ViewportSwitch";

export default function HtmlView({
	resource,
	content,
	viewState,
	onViewState,
	onNaturalHeight,
}: ResourceViewProps) {
	const t = useT();
	const text = content.kind === "text" ? content.text : "";
	const mode = useHtmlMode(resource);
	const offered = mode === "themed" && onNaturalHeight !== undefined;
	const [viewport, selectViewport] = useHtmlViewport(
		viewState,
		onViewState,
		offered ? "responsive" : "desktop",
	);
	const [contentHeight, setContentHeight] = useState<number | null>(null);
	const fit = offered && contentHeight !== null;
	useEffect(() => {
		if (offered) onNaturalHeight?.(fit);
	}, [offered, fit, onNaturalHeight]);
	return (
		<div
			data-testid="html-view"
			data-html-mode={mode}
			className={cn("flex min-h-0 flex-col bg-container-workspace-bg", fit ? null : "h-full")}
		>
			<HtmlPreviewNotice viewport={viewport} onViewport={selectViewport} />
			<div className={fit ? "flex-none" : "min-h-0 flex-1 p-12"}>
				<HtmlSourceFrame
					mode={mode}
					title={t("viewer.html.preview", { path: resource.path })}
					source={text}
					viewport={viewport}
					{...(offered ? { onContentHeight: setContentHeight } : {})}
					{...(fit ? { contentHeight } : {})}
				/>
			</div>
		</div>
	);
}
