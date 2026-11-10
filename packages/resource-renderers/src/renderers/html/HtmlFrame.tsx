import { cn } from "@thinkrail/ui/utils";
import type { CSSProperties, Ref } from "react";
import { clampContentHeight } from "./viewport";

export function HtmlFrame({
	title,
	document,
	sandbox = "",
	frameRef,
	onLoad,
	contentHeight,
}: {
	title: string;
	document: string;
	sandbox?: "" | "allow-same-origin" | "allow-scripts";
	frameRef?: Ref<HTMLIFrameElement>;
	onLoad?: () => void;
	contentHeight?: number;
}) {
	const height = contentHeight === undefined ? undefined : clampContentHeight(contentHeight);
	return (
		<div
			data-testid="html-frame-box"
			data-content-height={height}
			className={cn(
				"relative w-full overflow-hidden",
				height === undefined ? "h-full min-h-[360px]" : "h-[var(--html-box-height)]",
			)}
			style={
				height === undefined ? undefined : ({ "--html-box-height": `${height}px` } as CSSProperties)
			}
		>
			<iframe
				ref={frameRef}
				title={title}
				sandbox={sandbox}
				srcDoc={document}
				onLoad={onLoad}
				className="absolute inset-0 h-full w-full border-0 bg-container-workspace-bg"
			/>
		</div>
	);
}
