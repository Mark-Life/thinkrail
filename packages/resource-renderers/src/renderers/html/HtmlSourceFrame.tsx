import { useMemo } from "react";
import type { ResourceHtmlMode } from "../../host";
import { HtmlFrame } from "./HtmlFrame";
import { buildHtmlPreviewDocument } from "./htmlDocument";
import { ScriptedHtmlFrame } from "./ScriptedHtmlFrame";
import { ThemedHtmlFrame } from "./ThemedHtmlFrame";

interface SourceFrameProps {
	title: string;
	source: string;
}

function StaticHtmlFrame({ title, source }: SourceFrameProps) {
	const document = useMemo(() => buildHtmlPreviewDocument(source), [source]);
	return <HtmlFrame title={title} document={document} />;
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
	return <StaticHtmlFrame title={props.title} source={props.source} />;
}
