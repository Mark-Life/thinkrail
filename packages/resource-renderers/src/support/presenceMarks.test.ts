import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { PresenceWriter } from "../registry";

mock.module("monaco-editor/esm/vs/editor/editor.api.js", () => ({
	editor: {
		TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 },
		ContentWidgetPositionPreference: { EXACT: 0 },
		OverlayWidgetPositionPreference: { TOP_RIGHT_CORNER: 0 },
	},
}));

const { attachPresence } = await import("./presenceMarks");

interface Range {
	startLineNumber: number;
	endLineNumber: number;
}
interface Decoration {
	range: Range;
	options: { linesDecorationsClassName?: string };
}
interface Collection {
	decorations: Decoration[];
}

const TEXT = `${Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
const lineOffset = (line: number) =>
	TEXT.split("\n")
		.slice(0, line - 1)
		.join("\n").length + 1;

const AGENT: PresenceWriter = { id: "agent:s1", label: "Agent", tone: "agent1", inferred: false };
const OTHER: PresenceWriter = { id: "agent:s2", label: "Other", tone: "agent2", inferred: false };
const OUTSIDE: PresenceWriter = {
	id: "external",
	label: "Outside",
	tone: "external",
	inferred: true,
};
const USER: PresenceWriter = { id: "user", label: "You", tone: "user", inferred: false };

let collections: Collection[];
let flags: unknown[];
let chips: unknown[];
let announced: string[];
const originalDocument = globalThis.document;

const fakeEditor = () => ({
	getModel: () => ({ getLineCount: () => 20, getLineMaxColumn: () => 8 }),
	createDecorationsCollection(initial: Decoration[]) {
		const collection: Collection = { decorations: initial };
		collections.push(collection);
		return {
			getRanges: () => collection.decorations.map((decoration) => decoration.range),
			getRange: (index: number) => collection.decorations[index]?.range ?? null,
			set(next: Decoration[]) {
				collection.decorations = next;
			},
			append(more: Decoration[]) {
				collection.decorations = [...collection.decorations, ...more];
			},
			clear() {
				collection.decorations = [];
			},
		};
	},
	addContentWidget: (widget: unknown) => flags.push(widget),
	removeContentWidget: (widget: unknown) => flags.splice(flags.indexOf(widget), 1),
	addOverlayWidget: (widget: unknown) => chips.push(widget),
	removeOverlayWidget: (widget: unknown) => chips.splice(chips.indexOf(widget), 1),
});

const attach = () =>
	attachPresence(fakeEditor() as never, {
		text: () => ({
			hover: (writer) => `Changed by ${writer.label}`,
			lines: (writer, start, end) => `${writer.label} changed ${start}-${end}`,
			file: (writer) => `${writer.label} rewrote this file`,
		}),
		announce: (message) => announced.push(message),
	});

const editLine = (line: number, hash: string, insert = `edit ${hash}`) => {
	const from = lineOffset(line);
	return { hash, before: TEXT, changes: [{ from, to: from + `line ${line}`.length, insert }] };
};

const bars = () =>
	collections
		.flatMap((collection) => collection.decorations)
		.map((decoration) => decoration.options.linesDecorationsClassName)
		.filter((name) => name !== undefined);

beforeAll(() => {
	globalThis.document = {
		createElement: () => ({ dataset: {}, setAttribute() {} }),
	} as unknown as Document;
});

afterAll(() => {
	globalThis.document = originalDocument;
});

beforeEach(() => {
	collections = [];
	flags = [];
	chips = [];
	announced = [];
});

describe("attachPresence", () => {
	test("a hash two writers produced is credited to the newest one", () => {
		const marks = attach();
		marks.setWrites([
			{ hash: "h1", writer: AGENT },
			{ hash: "h1", writer: OUTSIDE },
		]);
		marks.land(editLine(4, "h1"));
		expect(bars()).toEqual(["presence-bar presence-tone-agent1"]);
		marks.dispose();
	});

	test("a landing that only matches an older write stays unknown", () => {
		const marks = attach();
		marks.setWrites([
			{ hash: "h0", writer: OUTSIDE },
			{ hash: "h1", writer: AGENT },
		]);
		marks.land(editLine(4, "h1"));
		expect(bars()).toEqual([]);
		expect(announced).toEqual([]);
		marks.dispose();
	});

	test("your own write paints, flags and announces nothing", () => {
		const marks = attach();
		marks.setWrites([{ hash: "mine", writer: USER }]);
		marks.land(editLine(4, "mine"));
		marks.land({
			hash: "mine",
			before: TEXT,
			changes: [{ from: 0, to: TEXT.length, insert: "x\n" }],
		});
		expect(bars()).toEqual([]);
		expect(flags).toEqual([]);
		expect(chips).toEqual([]);
		expect(announced).toEqual([]);
		marks.dispose();
	});

	test("a burst from one writer keeps one mark, one flag and one announcement", () => {
		const marks = attach();
		for (let index = 0; index < 5; index++) {
			marks.setWrites([{ hash: `h${index}`, writer: AGENT }]);
			marks.land(editLine(index === 4 ? 9 : 3, `h${index}`));
		}
		const live = collections.filter((collection) => collection.decorations.length > 0);
		expect(live).toHaveLength(1);
		expect(live[0]?.decorations.map((decoration) => decoration.range.startLineNumber)).toEqual([
			9, 3,
		]);
		expect(flags).toHaveLength(1);
		expect(announced).toEqual(["Agent changed 3-3"]);
		marks.dispose();
	});

	test("a second writer on the same line takes the flag", () => {
		const marks = attach();
		marks.setWrites([{ hash: "a", writer: AGENT }]);
		marks.land(editLine(5, "a"));
		marks.setWrites([{ hash: "b", writer: OTHER }]);
		marks.land(editLine(5, "b"));
		expect(flags).toHaveLength(1);
		expect(bars()).toEqual([
			"presence-bar presence-tone-agent1",
			"presence-bar presence-tone-agent2",
		]);
		marks.dispose();
	});
});
