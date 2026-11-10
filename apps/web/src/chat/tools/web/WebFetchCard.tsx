import { RiLinksLine as LinkIcon } from "@remixicon/react";
import { resultText, strArg, strListArg, type ToolRenderProps } from "@thinkrail/extension-api/web";
import { useT } from "@thinkrail/locales/react";
import { ToolFileLink } from "../ToolFileLink";
import type { FetchContentInput } from "./inputs";
import { WebResultBody } from "./WebResultBody";

function httpUrl(value: string): URL | null {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
}

function firstUrl(args: Record<string, unknown>): string {
	return (
		strArg<FetchContentInput>(args, "url") || (strListArg<FetchContentInput>(args, "urls")[0] ?? "")
	);
}

export function webFetchSummary({ args }: ToolRenderProps): string {
	return firstUrl(args);
}

export function WebFetchCard({
	toolCallId,
	args,
	result,
	status,
	workspaceRoot,
	onOpenFile,
}: ToolRenderProps) {
	const t = useT();
	const url = firstUrl(args);
	const external = httpUrl(url);
	const label = external
		? external.hostname.replace(/^www\./, "")
		: t("tools.webFetch.fallbackLabel");
	const output = resultText(result);

	return (
		<div data-testid="tool-fetch_content" className="flex flex-col gap-4">
			<div className="flex items-center gap-4 tr-text-metadata">
				<LinkIcon className="size-12 shrink-0 text-text-muted" />
				{external ? (
					<a
						href={external.href}
						target="_blank"
						rel="noreferrer"
						className="truncate text-primary hover:underline"
						title={url}
					>
						{label}
					</a>
				) : url ? (
					<ToolFileLink
						path={url}
						workspaceRoot={workspaceRoot}
						onOpenFile={onOpenFile}
						disabled={status === "running"}
						className="text-primary"
					/>
				) : (
					<span className="text-primary">{label}</span>
				)}
			</div>
			<WebResultBody
				id={`${toolCallId}:content`}
				output={output}
				status={status}
				runningLabel={t("tools.webFetch.running")}
				emptyLabel={t("tools.webFetch.empty")}
			/>
		</div>
	);
}
