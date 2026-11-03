import { memo, useEffect, useMemo, useRef } from "react";
import type { ThemedToken } from "shiki/core";
import type { GraphSide, SymbolId } from "../../core/types";
import { fileLine } from "../lib/format";
import { isWireEdge } from "../lib/graphIndex";
import { useSource, useVirtualRows } from "../lib/hooks";
import { fileHref, symbolHref } from "../lib/route";
import {
	edgesByLine,
	innermostSymbol,
	type LineLink,
	type LineToken,
	linksForLine,
	splitTokens,
} from "../lib/sourceLinks";
import { useGraph, useWorkspace } from "../lib/workspace";
import { CopyButton } from "./CopyButton";
import { InlineMessage } from "./States";

const LINE_HEIGHT = 20;
const SCROLL_CONTEXT_LINES = 4;

const SourceLine = memo(function SourceLine(props: {
	number: number;
	text: string;
	tokens: ThemedToken[] | undefined;
	links: readonly LineLink[];
	focused: boolean;
	top: number;
	linkFor: (target: SymbolId) => string;
}) {
	const base: readonly LineToken[] = props.tokens ?? [{ content: props.text }];
	const segments = splitTokens({ tokens: base, links: props.links });
	return (
		<div
			className={props.focused ? "src-line src-line-focus" : "src-line"}
			style={{ top: props.top }}
			data-line={props.number}
		>
			<span className="src-number">{props.number}</span>
			<span className="src-text">
				{segments.map((segment, index) => {
					const key = `${index}:${segment.content.length}`;
					const style = segment.color ? { color: segment.color } : undefined;
					if (!segment.link) {
						return (
							<span key={key} style={style}>
								{segment.content}
							</span>
						);
					}
					const wire = isWireEdge(segment.link);
					return (
						<a
							key={key}
							href={props.linkFor(segment.link.target)}
							className={wire ? "src-link src-link-wire" : "src-link"}
							title={`${wire ? "Crosses the wire to " : "Go to "}${segment.link.title}`}
							style={wire ? undefined : style}
						>
							{segment.content}
						</a>
					);
				})}
			</span>
		</div>
	);
});

export function SourcePane(props: {
	side: GraphSide;
	file: string;
	focusStart?: number | undefined;
	focusEnd?: number | undefined;
	linkFor?: ((target: SymbolId) => string) | undefined;
}) {
	const { side, file, focusStart, focusEnd } = props;
	const { session } = useWorkspace();
	const index = useGraph(side);
	const source = useSource({ side, file });
	const containerRef = useRef<HTMLDivElement>(null);
	const lines = source.status === "ready" ? source.lines : [];
	const tokens = source.status === "ready" ? source.tokens : [];
	const range = useVirtualRows({ containerRef, count: lines.length, rowHeight: LINE_HEIGHT });
	const lineEdges = useMemo(() => edgesByLine(index.fileEdges.get(file) ?? []), [index, file]);
	const linkFor = useMemo(
		() => props.linkFor ?? ((target: SymbolId) => symbolHref(target, side)),
		[props.linkFor, side],
	);
	const ready = source.status === "ready";

	useEffect(() => {
		const element = containerRef.current;
		if (!element || !ready) return;
		const line = Math.max(0, (focusStart ?? 1) - 1 - SCROLL_CONTEXT_LINES);
		element.scrollTop = line * LINE_HEIGHT;
		element.scrollLeft = 0;
	}, [focusStart, ready]);

	const longest = useMemo(
		() => lines.reduce((max, text) => Math.max(max, text.length), 0),
		[lines],
	);
	const fileSymbols = useMemo(() => index.fileSymbols.get(file) ?? [], [index, file]);
	const visible = useMemo(() => {
		const rows: { number: number; text: string; links: LineLink[] }[] = [];
		for (let position = range.start; position < Math.min(range.end, lines.length); position++) {
			const number = position + 1;
			const text = lines[position] ?? "";
			const edges = lineEdges.get(number) ?? [];
			const owner = innermostSymbol(fileSymbols, number);
			const enclosing = owner ? (index.outgoing.get(owner.id) ?? []) : [];
			rows.push({
				number,
				text,
				links: linksForLine({ text, edges, enclosing, symbols: index.symbols }),
			});
		}
		return rows;
	}, [range, lines, lineEdges, index, fileSymbols]);

	return (
		<section className="source-pane" aria-label={`Source of ${file}`}>
			<div className="source-header">
				<a className="source-path" href={fileHref({ file, side })} title="Open file">
					{focusStart ? fileLine({ file, line: focusStart }) : file}
				</a>
				<CopyButton
					text={focusStart ? fileLine({ file, line: focusStart }) : file}
					label="Copy file and line"
				/>
				{session.mode === "diff" ? <span className={`side-tag side-${side}`}>{side}</span> : null}
			</div>
			{source.status === "loading" ? <div className="source-state">Loading source</div> : null}
			{source.status === "error" ? (
				<InlineMessage title="Source could not be loaded" tone="error">
					<p>The server did not return this file. It may have stopped.</p>
					<button type="button" className="button" onClick={source.retry}>
						Retry
					</button>
				</InlineMessage>
			) : null}
			<div className="source-body" ref={containerRef} hidden={!ready}>
				<div
					className="source-canvas"
					style={{ height: lines.length * LINE_HEIGHT, width: `calc(${longest}ch + 80px)` }}
				>
					{visible.map((row) => (
						<SourceLine
							key={row.number}
							number={row.number}
							text={row.text}
							tokens={tokens[row.number - 1]}
							links={row.links}
							focused={
								focusStart !== undefined &&
								row.number >= focusStart &&
								row.number <= (focusEnd ?? focusStart)
							}
							top={(row.number - 1) * LINE_HEIGHT}
							linkFor={linkFor}
						/>
					))}
				</div>
			</div>
		</section>
	);
}
