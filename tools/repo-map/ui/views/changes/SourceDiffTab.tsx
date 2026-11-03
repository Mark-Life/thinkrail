import { useMemo, useRef, useState } from "react";
import type { ChangeGroup, CodeSymbol, SymbolChange, SymbolId } from "../../../core/types";
import { CopyButton } from "../../components/CopyButton";
import { InlineMessage } from "../../components/States";
import { changeBaseId, changeHeadId, changeId } from "../../lib/changes";
import { fileLine } from "../../lib/format";
import { useSource, useVirtualRows } from "../../lib/hooks";
import { type DiffCell, type DisplayRow, foldUnchanged, sideBySide } from "../../lib/lineDiff";
import { useWorkspace } from "../../lib/workspace";

const ROW_HEIGHT = 20;
const CONTEXT_LINES = 3;

type Tokens = readonly (readonly { content: string; color?: string | undefined }[])[];

function Cell(props: { cell: DiffCell | undefined; mark: string; tone: string; tokens: Tokens }) {
	const { cell, mark, tone, tokens } = props;
	if (!cell) return <div className="diff-cell diff-cell-empty" />;
	const line = tokens[cell.line - 1];
	return (
		<div className={`diff-cell ${tone}`}>
			<span className="src-number">{cell.line}</span>
			<span className="diff-mark">{mark}</span>
			<span className="src-text">
				{line
					? line.map((token, index) => (
							<span
								key={`${index}:${token.content.length}`}
								style={token.color ? { color: token.color } : undefined}
							>
								{token.content}
							</span>
						))
					: cell.text}
			</span>
		</div>
	);
}

function DiffRowView(props: {
	row: DisplayRow;
	top: number;
	left: Tokens;
	right: Tokens;
	onExpand: () => void;
}) {
	const { row, top, left, right, onExpand } = props;
	if (row.kind === "fold") {
		return (
			<button type="button" className="diff-fold" style={{ top }} onClick={onExpand}>
				{row.hidden} unchanged lines. Show all
			</button>
		);
	}
	const leftCell = row.kind === "add" ? undefined : row.left;
	const rightCell = row.kind === "remove" ? undefined : row.right;
	const changed = row.kind !== "same";
	return (
		<div className="diff-row" style={{ top }}>
			<Cell
				cell={leftCell}
				mark={changed && leftCell ? "-" : " "}
				tone={changed ? "diff-line-removed" : ""}
				tokens={left}
			/>
			<Cell
				cell={rightCell}
				mark={changed && rightCell ? "+" : " "}
				tone={changed ? "diff-line-added" : ""}
				tokens={right}
			/>
		</div>
	);
}

function sliceSymbol(text: string, symbol: Pick<CodeSymbol, "startLine" | "endLine"> | undefined) {
	if (!symbol) return "";
	return `${text
		.split("\n")
		.slice(symbol.startLine - 1, symbol.endLine)
		.join("\n")}\n`;
}

function DiffBody(props: { before?: CodeSymbol | undefined; after?: CodeSymbol | undefined }) {
	const { before, after } = props;
	const beforeSource = useSource({ side: "base", file: before?.file ?? "" });
	const afterSource = useSource({ side: "head", file: after?.file ?? "" });
	const [expanded, setExpanded] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const ready =
		(!before || beforeSource.status === "ready") && (!after || afterSource.status === "ready");
	const rows = useMemo(() => {
		if (!ready) return [];
		const beforeText =
			before && beforeSource.status === "ready" ? sliceSymbol(beforeSource.text, before) : "";
		const afterText =
			after && afterSource.status === "ready" ? sliceSymbol(afterSource.text, after) : "";
		return sideBySide({
			before: beforeText,
			after: afterText,
			beforeStart: before?.startLine ?? 1,
			afterStart: after?.startLine ?? 1,
		});
	}, [ready, before, after, beforeSource, afterSource]);
	const display = useMemo<DisplayRow[]>(
		() => (expanded ? rows : foldUnchanged({ rows, context: CONTEXT_LINES })),
		[rows, expanded],
	);
	const range = useVirtualRows({ containerRef, count: display.length, rowHeight: ROW_HEIGHT });
	const failed =
		(before && beforeSource.status === "error" ? beforeSource : undefined) ??
		(after && afterSource.status === "error" ? afterSource : undefined);
	if (failed) {
		return (
			<InlineMessage title="Source could not be loaded" tone="error">
				<button type="button" className="button" onClick={failed.retry}>
					Retry
				</button>
			</InlineMessage>
		);
	}
	const leftTokens = beforeSource.status === "ready" ? beforeSource.tokens : [];
	const rightTokens = afterSource.status === "ready" ? afterSource.tokens : [];
	return (
		<div className="diff-scroll" ref={containerRef}>
			{ready ? null : <div className="source-state">Loading source</div>}
			<div className="diff-canvas" style={{ height: display.length * ROW_HEIGHT }}>
				{display.slice(range.start, range.end).map((row, offset) => {
					const position = range.start + offset;
					return (
						<DiffRowView
							key={position}
							row={row}
							top={position * ROW_HEIGHT}
							left={leftTokens}
							right={rightTokens}
							onExpand={() => setExpanded(true)}
						/>
					);
				})}
			</div>
		</div>
	);
}

function findChange(group: ChangeGroup, focus: SymbolId | undefined): SymbolChange | undefined {
	return group.symbolChanges.find((change) => changeId(change) === focus) ?? group.symbolChanges[0];
}

export function SourceDiffTab(props: { group: ChangeGroup; focus: SymbolId | undefined }) {
	const { group, focus } = props;
	const { head, base } = useWorkspace();
	const change = findChange(group, focus);
	if (!change) return null;
	const headId = changeHeadId(change);
	const baseId = changeBaseId(change);
	const after = headId ? head.symbols.get(headId) : undefined;
	const before = baseId ? base?.symbols.get(baseId) : undefined;
	const leftLabel = before
		? fileLine({ file: before.file, line: before.startLine })
		: "not in base";
	const rightLabel = after ? fileLine({ file: after.file, line: after.startLine }) : "not in head";
	return (
		<div className="source-diff">
			<div className="diff-headers">
				<div className="diff-header">
					<span className="side-tag side-base">base</span>
					<span className="diff-path" title={leftLabel}>
						{leftLabel}
					</span>
					{before ? <CopyButton text={leftLabel} label="Copy file and line" /> : null}
				</div>
				<div className="diff-header">
					<span className="side-tag side-head">head</span>
					<span className="diff-path" title={rightLabel}>
						{rightLabel}
					</span>
					{after ? <CopyButton text={rightLabel} label="Copy file and line" /> : null}
				</div>
			</div>
			<DiffBody key={changeId(change)} before={before} after={after} />
		</div>
	);
}
