import { arr, compile, obj, str, unknown } from "@earendil-works/pi-schema";
import { RiSearchLine as Search } from "@remixicon/react";
import { resultText, strArg, strListArg, type ToolRenderProps } from "@thinkrail/extension-api/web";
import { useT } from "@thinkrail/locales/react";
import type { WebSearchInput } from "./inputs";
import { WebResultBody } from "./WebResultBody";

function firstQuery(args: Record<string, unknown>): string {
	return (
		strArg<WebSearchInput>(args, "query") || (strListArg<WebSearchInput>(args, "queries")[0] ?? "")
	);
}

export function webSearchSummary({ args }: ToolRenderProps): string {
	return firstQuery(args);
}

const OPEN = { open: true };
const detailsProvider = compile(obj({ details: obj({ provider: str() }, OPEN) }, OPEN));
const detailsResults = compile(obj({ details: obj({ results: arr(unknown()) }, OPEN) }, OPEN));
const resultProvider = compile(obj({ provider: str() }, OPEN));

function providerOf(result: unknown): string {
	if (detailsProvider.check(result)) return result.details.provider;
	if (!detailsResults.check(result)) return "";
	const first = result.details.results[0];
	return resultProvider.check(first) ? first.provider : "";
}

export function WebSearchCard({ toolCallId, args, result, status }: ToolRenderProps) {
	const t = useT();
	const query = firstQuery(args);
	const provider = providerOf(result);
	const output = resultText(result);

	return (
		<div data-testid="tool-web_search" className="flex flex-col gap-4">
			<div className="flex items-center gap-4 tr-text-metadata">
				<Search className="size-12 shrink-0 text-text-muted" />
				<span className="truncate text-primary" title={query}>
					{query}
				</span>
				{provider ? (
					<span className="shrink-0 text-text-muted">{t("tools.webSearch.via", { provider })}</span>
				) : null}
			</div>
			<WebResultBody
				id={`${toolCallId}:content`}
				output={output}
				status={status}
				runningLabel={t("tools.webSearch.running")}
				emptyLabel={t("tools.webSearch.empty")}
			/>
		</div>
	);
}
