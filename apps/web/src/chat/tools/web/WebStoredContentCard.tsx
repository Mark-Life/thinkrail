import { compile, obj, str } from "@earendil-works/pi-schema";
import { RiLinksLine as LinkIcon } from "@remixicon/react";
import { numArg, resultText, strArg, type ToolRenderProps } from "@thinkrail/extension-api/web";
import { type Translator, useT } from "@thinkrail/locales/react";
import type { GetSearchContentInput } from "./inputs";
import { WebResultBody } from "./WebResultBody";

const OPEN = { open: true };
const detailsQuery = compile(obj({ details: obj({ query: str() }, OPEN) }, OPEN));
const detailsUrl = compile(obj({ details: obj({ url: str() }, OPEN) }, OPEN));

export function storedContentTarget(
	t: Translator,
	args: Record<string, unknown>,
	result: unknown,
): string {
	const query =
		strArg<GetSearchContentInput>(args, "query") ||
		(detailsQuery.check(result) ? result.details.query : "");
	if (query) return query;
	const url =
		strArg<GetSearchContentInput>(args, "url") ||
		(detailsUrl.check(result) ? result.details.url : "");
	if (url) return url;
	const queryIndex = numArg<GetSearchContentInput>(args, "queryIndex");
	if (queryIndex !== null) return t("tools.webStored.queryIndex", { index: queryIndex });
	const urlIndex = numArg<GetSearchContentInput>(args, "urlIndex");
	if (urlIndex !== null) return t("tools.webStored.urlIndex", { index: urlIndex });
	return "";
}

export function storedContentSummary({ args, result }: ToolRenderProps, t: Translator): string {
	return storedContentTarget(t, args, result) || strArg<GetSearchContentInput>(args, "responseId");
}

export function WebStoredContentCard({ toolCallId, args, result, status }: ToolRenderProps) {
	const t = useT();
	const responseId = strArg<GetSearchContentInput>(args, "responseId");
	const target = storedContentTarget(t, args, result);
	const output = resultText(result);
	return (
		<div data-testid="tool-get_search_content" className="flex flex-col gap-4">
			<div className="flex items-center gap-4 tr-text-metadata">
				<LinkIcon className="size-12 shrink-0 text-text-muted" />
				<span className="min-w-0 truncate text-primary" title={target || responseId}>
					{target || responseId || t("tools.webStored.fallbackLabel")}
				</span>
				{target && responseId ? (
					<span className="shrink-0 text-text-muted" title={responseId}>
						{responseId}
					</span>
				) : null}
			</div>
			<WebResultBody
				id={`${toolCallId}:content`}
				output={output}
				status={status}
				runningLabel={t("tools.webStored.running")}
				emptyLabel={t("tools.webStored.empty")}
			/>
		</div>
	);
}
