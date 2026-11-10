import { useT } from "@thinkrail/locales/react";
import { useEffect, useState } from "react";
import type { ResourceContent, ResourceDiffProps } from "../../registry";
import { diffContentStamp } from "../reviewComposerState";
import { VisualDiff, type VisualDiffSide } from "../VisualDiff";
import { HtmlSourceFrame } from "./HtmlSourceFrame";
import { useHtmlMode } from "./useHtmlMode";

function textOf(content: ResourceContent): string | null {
	return content.kind === "text" ? content.text : null;
}

export default function HtmlDiff({
	resource,
	originalResource = resource,
	original,
	modified,
	onNaturalHeight,
}: ResourceDiffProps) {
	const t = useT();
	const noDocument = t("viewer.html.noDocument");
	const originalMode = useHtmlMode(originalResource);
	const modifiedMode = useHtmlMode(resource);
	const originalText = textOf(original);
	const modifiedText = textOf(modified);
	const offered =
		onNaturalHeight !== undefined &&
		(originalText === null || originalMode !== "static") &&
		(modifiedText === null || modifiedMode !== "static") &&
		(originalText !== null || modifiedText !== null);
	const [originalHeight, setOriginalHeight] = useState<number | null>(null);
	const [modifiedHeight, setModifiedHeight] = useState<number | null>(null);
	const fit =
		offered &&
		(originalText === null || originalHeight !== null) &&
		(modifiedText === null || modifiedHeight !== null);
	const fitted = fit ? { contentHeight: Math.max(originalHeight ?? 0, modifiedHeight ?? 0) } : {};
	useEffect(() => {
		if (offered) onNaturalHeight?.(fit);
	}, [offered, fit, onNaturalHeight]);
	const originalSide: VisualDiffSide = {
		present: originalText !== null,
		content:
			originalText === null ? null : (
				<HtmlSourceFrame
					mode={originalMode}
					source={originalText}
					title={t("viewer.html.originalPreview", { path: originalResource.path })}
					{...(offered ? { onContentHeight: setOriginalHeight } : {})}
					{...fitted}
				/>
			),
		caption:
			originalText === null
				? t("viewer.side.oldCaption", { detail: noDocument })
				: t("viewer.html.oldDocument"),
		intrinsicSize: null,
	};
	const modifiedSide: VisualDiffSide = {
		present: modifiedText !== null,
		content:
			modifiedText === null ? null : (
				<HtmlSourceFrame
					mode={modifiedMode}
					source={modifiedText}
					title={t("viewer.html.modifiedPreview", { path: resource.path })}
					{...(offered ? { onContentHeight: setModifiedHeight } : {})}
					{...fitted}
				/>
			),
		caption:
			modifiedText === null
				? t("viewer.side.newCaption", { detail: noDocument })
				: t("viewer.html.newDocument"),
		intrinsicSize: null,
	};
	return (
		<div
			data-testid="html-diff-view"
			data-fit={fit}
			className={fit ? "flex flex-col" : "flex h-full min-h-0 flex-col"}
		>
			<div className={fit ? "flex-none" : "min-h-0 flex-1"}>
				<VisualDiff
					prefix="html"
					noun="document"
					selectionKey="document"
					commentLabel={t("viewer.region.commentOnDocument")}
					original={originalSide}
					modified={modifiedSide}
					contentStamp={diffContentStamp(original, modified)}
					initialMode="2-up"
					modes={["2-up"]}
					emptyLabel={noDocument}
					fitContent={fit}
				/>
			</div>
		</div>
	);
}
