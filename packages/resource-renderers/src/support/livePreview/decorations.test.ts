import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { type DecorationSet, EditorView } from "@codemirror/view";
import { livePreview, portalHost, setConflicts, setFocused, setThreads } from "./decorations";
import { markdownLanguage } from "./language";
import { type PortalContent, type PortalHost, PortalWidget } from "./portals";

const host: PortalHost = {
	mount: () => {},
	update: () => {},
	unmount: () => {},
	subscribe: () => () => {},
	snapshot: () => [],
	onResize: () => {},
};

const DOC = "intro\n\n```\nx\ny\nz\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\nend\n";

function create(doc = DOC) {
	return EditorState.create({
		doc,
		extensions: [markdownLanguage, livePreview, portalHost.of(host)],
	});
}

function sets(state: EditorState): DecorationSet[] {
	return state
		.facet(EditorView.decorations)
		.flatMap((entry) => (typeof entry === "function" ? [] : [entry]));
}

interface Drawn {
	from: number;
	to: number;
	kind: PortalContent["kind"] | "line";
}

function drawn(state: EditorState): Drawn[] {
	const out: Drawn[] = [];
	for (const set of sets(state)) {
		for (let cursor = set.iter(); cursor.value; cursor.next()) {
			const { widget } = cursor.value.spec;
			const kind = widget instanceof PortalWidget ? widget.content.kind : "line";
			out.push({ from: cursor.from, to: cursor.to, kind });
		}
	}
	return out;
}

function blocks(state: EditorState) {
	return drawn(state).filter((item) => item.kind === "block");
}

const fence = { from: DOC.indexOf("```"), to: DOC.indexOf("```\n\n") + 3 };

describe("block widgets", () => {
	test("a block that holds a conflict stays source, so its lens and lines show", () => {
		const y = DOC.indexOf("y\n");
		const state = create().update({
			effects: setConflicts.of([{ id: 1, from: y, to: y + 2, theirs: "Y\n" }]),
		}).state;
		expect(blocks(state).some((block) => block.from === fence.from)).toBe(false);
		expect(blocks(state)).toHaveLength(1);
		expect(drawn(state).filter((item) => item.kind === "lens")).toEqual([
			{ from: y, to: y, kind: "lens" },
		]);
		const cleared = state.update({ effects: setConflicts.of([]) }).state;
		expect(blocks(cleared)).toHaveLength(2);
	});

	test("a thread on an inner line of a block draws after the block", () => {
		const tableEnd = DOC.indexOf("| 3 | 4 |") + "| 3 | 4 |".length;
		const state = create().update({
			effects: setThreads.of([
				{ id: "code", line: 5 },
				{ id: "table", line: 10 },
				{ id: "end", line: 14 },
			]),
		}).state;
		const threads = drawn(state).filter((item) => item.kind === "thread");
		expect(threads.map((item) => item.from)).toEqual([fence.to, tableEnd, DOC.indexOf("end") + 3]);
		const inside = state.update({
			selection: { anchor: DOC.indexOf("y") },
			effects: setFocused.of(true),
		}).state;
		const shown = drawn(inside).filter((item) => item.kind === "thread");
		expect(shown.map((item) => item.from)).toEqual([
			DOC.indexOf("y") + 1,
			tableEnd,
			DOC.indexOf("end") + 3,
		]);
	});

	test("a caret move that enters or leaves no block keeps the block decorations", () => {
		const focused = create().update({
			selection: { anchor: 1 },
			effects: setFocused.of(true),
		}).state;
		const before = sets(focused);
		const moved = focused.update({ selection: { anchor: 3 } }).state;
		expect(sets(moved)[1]).toBe(before[1]);
		const entered = moved.update({ selection: { anchor: DOC.indexOf("y") } }).state;
		expect(blocks(entered)).toHaveLength(1);
	});
});
