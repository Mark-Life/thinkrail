import {
	closeSearchPanel,
	findNext,
	findPrevious,
	getSearchQuery,
	SearchQuery,
	setSearchQuery,
} from "@codemirror/search";
import { type EditorView, runScopeHandlers } from "@codemirror/view";
import { RiArrowDownLine, RiArrowUpLine, RiCloseLine } from "@remixicon/react";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { useLayoutEffect, useRef } from "react";
import { FIND_FIELD } from "./livePreview";

export function LiveFindBar({ view }: { view: EditorView }) {
	const t = useT();
	const fieldRef = useRef<HTMLInputElement>(null);
	useLayoutEffect(() => {
		fieldRef.current?.focus();
		fieldRef.current?.select();
	}, []);
	const close = () => {
		closeSearchPanel(view);
		view.focus();
	};
	return (
		<search
			data-testid="markdown-find"
			className="flex items-center gap-4 border-border-default border-b bg-container-workspace-bg py-4"
		>
			<input
				{...{ [FIND_FIELD]: "true" }}
				ref={fieldRef}
				type="search"
				defaultValue={getSearchQuery(view.state).search}
				aria-label={t("viewer.markdown.find")}
				placeholder={t("viewer.markdown.find")}
				spellCheck={false}
				className="h-28 min-w-0 flex-1 rounded-sm border border-control-border-default bg-control-bg px-8 tr-text-ui text-text-default outline-none placeholder:text-text-muted focus-visible:border-control-border-active"
				onChange={(event) =>
					view.dispatch({
						effects: setSearchQuery.of(new SearchQuery({ search: event.target.value })),
					})
				}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						(event.shiftKey ? findPrevious : findNext)(view);
					} else if (event.key === "Escape") {
						event.preventDefault();
						close();
					} else if (runScopeHandlers(view, event.nativeEvent, "search-panel")) {
						event.preventDefault();
					}
				}}
			/>
			<Button
				size="icon"
				variant="ghost"
				aria-label={t("viewer.markdown.findPrevious")}
				onClick={() => findPrevious(view)}
			>
				<RiArrowUpLine className="size-16" />
			</Button>
			<Button
				size="icon"
				variant="ghost"
				aria-label={t("viewer.markdown.findNext")}
				onClick={() => findNext(view)}
			>
				<RiArrowDownLine className="size-16" />
			</Button>
			<Button
				size="icon"
				variant="ghost"
				aria-label={t("viewer.markdown.findClose")}
				onClick={close}
			>
				<RiCloseLine className="size-16" />
			</Button>
		</search>
	);
}
