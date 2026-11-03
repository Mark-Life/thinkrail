import { useEffect, useMemo, useRef, useState } from "react";
import { kindLabel } from "../lib/format";
import { fileHref, mapHref, symbolHref } from "../lib/route";
import { SEARCH_FILTERS, type SearchEntry, type SearchFilter, searchEntries } from "../lib/search";
import { useWorkspace } from "../lib/workspace";

const RESULT_LIMIT = 60;

function hrefOf(entry: SearchEntry) {
	if (entry.type === "symbol") return symbolHref(entry.id);
	if (entry.type === "file") return fileHref({ file: entry.path });
	return mapHref({ path: entry.path });
}

function badgeOf(entry: SearchEntry) {
	if (entry.type === "symbol") return kindLabel(entry.kind);
	return entry.type === "file" ? "file" : "mod";
}

export function Palette(props: { onClose: () => void }) {
	const { searchEntries: entries } = useWorkspace();
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<SearchFilter>("all");
	const [active, setActive] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const results = useMemo(
		() => searchEntries({ entries, query, filter, limit: RESULT_LIMIT }),
		[entries, query, filter],
	);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	useEffect(() => {
		listRef.current?.querySelector(".palette-row-active")?.scrollIntoView({ block: "nearest" });
	});

	const select = (entry: SearchEntry | undefined) => {
		if (!entry) return;
		window.location.hash = hrefOf(entry);
		props.onClose();
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			props.onClose();
		} else if (event.key === "ArrowDown") {
			event.preventDefault();
			setActive((value) => Math.min(results.length - 1, value + 1));
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setActive((value) => Math.max(0, value - 1));
		} else if (event.key === "Enter") {
			event.preventDefault();
			select(results[active]);
		} else if (event.key === "Tab") {
			event.preventDefault();
			const position = SEARCH_FILTERS.findIndex((item) => item.id === filter);
			const step = event.shiftKey ? -1 : 1;
			const next = SEARCH_FILTERS.at((position + step) % SEARCH_FILTERS.length);
			if (next) setFilter(next.id);
			setActive(0);
		}
	};

	return (
		<div className="palette-layer">
			<button
				type="button"
				className="palette-backdrop"
				aria-label="Close search"
				onClick={props.onClose}
				tabIndex={-1}
			/>
			<div className="palette" role="dialog" aria-modal="true" aria-label="Search">
				<input
					ref={inputRef}
					className="palette-input"
					value={query}
					placeholder="Search symbols, files, modules"
					aria-label="Search"
					onChange={(event) => {
						setQuery(event.target.value);
						setActive(0);
					}}
					onKeyDown={onKeyDown}
				/>
				<div className="palette-filters">
					{SEARCH_FILTERS.map((item) => (
						<button
							key={item.id}
							type="button"
							className={item.id === filter ? "chip chip-active" : "chip"}
							aria-pressed={item.id === filter}
							onClick={() => {
								setFilter(item.id);
								setActive(0);
								inputRef.current?.focus();
							}}
						>
							{item.label}
						</button>
					))}
					<span className="palette-tip">Tab cycles filters</span>
				</div>
				<div className="palette-results" ref={listRef}>
					{results.map((entry, index) => (
						<a
							key={`${entry.type}:${entry.detail}:${entry.label}:${index}`}
							href={hrefOf(entry)}
							tabIndex={-1}
							className={index === active ? "palette-row palette-row-active" : "palette-row"}
							onMouseEnter={() => setActive(index)}
							onClick={props.onClose}
						>
							<span className="kind-badge">{badgeOf(entry)}</span>
							<span className="palette-label">{entry.label}</span>
							<span className="palette-detail">{entry.detail}</span>
						</a>
					))}
					{query.trim() && results.length === 0 ? (
						<p className="palette-empty">Nothing matches "{query.trim()}".</p>
					) : null}
					{query.trim() ? null : (
						<p className="palette-empty">
							Type a name. Try <code>session.prompt</code>, <code>ChatView</code> or{" "}
							<code>packages/server</code>.
						</p>
					)}
				</div>
				<div className="palette-footer">
					<span>
						<kbd>Up</kbd> <kbd>Down</kbd> move
					</span>
					<span>
						<kbd>Enter</kbd> open
					</span>
					<span>
						<kbd>Esc</kbd> close
					</span>
				</div>
			</div>
		</div>
	);
}
