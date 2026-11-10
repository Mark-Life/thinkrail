import { useMemo } from "react";
import type { ResourceHtmlMode } from "../../host";
import { HtmlFrame } from "./HtmlFrame";
import { buildHtmlPreviewDocument } from "./htmlDocument";
import { ScriptedHtmlFrame } from "./ScriptedHtmlFrame";
import { ThemedHtmlFrame } from "./ThemedHtmlFrame";
import type { HtmlViewport } from "./viewport";

interface SourceFrameProps {
	title: string;
	source: string;
	viewport: HtmlViewport;
}

function StaticHtmlFrame({ title, source, viewport }: SourceFrameProps) {
	const document = useMemo(() => buildHtmlPreviewDocument(source), [source]);
	return <HtmlFrame title={title} document={document} viewport={viewport} />;
}

export function HtmlSourceFrame({
	mode,
	...props
}: SourceFrameProps & {
	mode: ResourceHtmlMode;
	contentHeight?: number;
	onContentHeight?: (height: number | null) => void;
}) {
	if (mode === "scripted") return <ScriptedHtmlFrame {...props} />;
	if (mode === "themed") return <ThemedHtmlFrame {...props} />;
	return <StaticHtmlFrame title={props.title} source={props.source} viewport={props.viewport} />;
}
