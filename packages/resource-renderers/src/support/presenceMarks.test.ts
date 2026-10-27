import { afterAll, beforeAll, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import type { PresenceWriter } from "../registry";

mock.module("monaco-editor/editor/editor.api.js", () => ({
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
	options: {
		linesDecorationsClassName?: string;
		linesDecorationsTooltip?: string;
		className?: string;
	};
}
interface Collection {
	decorations: Decoration[];
}

const TEXT = `${Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
const lineOffset = (line: number) =>
	TEXT.split("\n")
		.slice(0, line - 1)
		.join("\n").length + 1;

const AGENT: PresenceWriter = {
	id: "agent:s1",
	label: "Agent",
	spoken: "Agent",
	tone: "agent1",
	inferred: false,
};
const OTHER: PresenceWriter = {
	id: "agent:s2",
	label: "Other",
	spoken: "Other",
	tone: "agent2",
	inferred: false,
};
const ELSEWHERE: PresenceWriter = {
	id: "user:elsewhere",
	label: "You, in another window",
	spoken: "You, in another window",
	tone: "user",
	inferred: false,
};

interface FakeNode {
	className?: string;
	innerHTML?: string;
	textContent?: string;
}

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
			lines: (writer, spans) =>
				`${writer.spoken} changed ${spans.map((span) => `${span.startLine}-${span.endLine}`).join(", ")}`,
			places: (writer, count) => `${writer.spoken} changed ${count} places`,
			file: (name) => `${name} rewrote this file`,
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
		createElement: () => ({
			dataset: {},
			children: [] as unknown[],
			setAttribute() {},
			append(...nodes: unknown[]) {
				this.children.push(...nodes);
			},
		}),
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
	test("a landing is credited only when it matches the latest write", () => {
		const marks = attach();
		marks.setLatest({ hash: "h1", writer: AGENT });
		marks.land(editLine(4, "h1"));
		marks.land(editLine(9, "h0"));
		expect(bars()).toEqual(["presence-bar presence-tone-agent1"]);
		expect(announced).toEqual(["Agent changed 4-4"]);
		marks.dispose();
	});

	test("a landing with no latest write stays unknown", () => {
		const marks = attach();
		marks.land(editLine(4, "h1"));
		expect(bars()).toEqual([]);
		expect(announced).toEqual([]);
		marks.dispose();
	});

	test("a write you made in another window is marked in the user tone", () => {
		const marks = attach();
		marks.setLatest({ hash: "there", writer: ELSEWHERE });
		marks.land(editLine(4, "there"));
		expect(bars()).toEqual(["presence-bar presence-tone-user"]);
		expect(flags).toHaveLength(1);
		marks.dispose();
	});

	test("a burst from one writer keeps one mark, one flag and one announcement", () => {
		const marks = attach();
		for (let index = 0; index < 5; index++) {
			marks.setLatest({ hash: `h${index}`, writer: AGENT });
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

	test("a script write by the same agent keeps the agent's tool-edited lines solid", () => {
		const script: PresenceWriter = { ...AGENT, inferred: true };
		const marks = attach();
		marks.setLatest({ hash: "tool", writer: AGENT });
		marks.land(editLine(3, "tool"));
		marks.land(editLine(6, "tool2"));
		marks.setLatest({ hash: "tool2", writer: AGENT });
		marks.setLatest({ hash: "sh", writer: script });
		marks.land({
			hash: "sh",
			before: TEXT,
			changes: [
				{ from: lineOffset(6), to: lineOffset(6) + 6, insert: "script 6" },
				{ from: lineOffset(12), to: lineOffset(12) + 7, insert: "script 12" },
			],
		});
		const lines = collections.flatMap((collection) =>
			collection.decorations.map((decoration) => [
				decoration.range.startLineNumber,
				decoration.options.linesDecorationsClassName,
			]),
		);
		expect(lines.sort()).toEqual([
			[12, "presence-bar presence-tone-agent1 presence-inferred"],
			[3, "presence-bar presence-tone-agent1"],
			[6, "presence-bar presence-tone-agent1 presence-inferred"],
		]);
		marks.dispose();
	});

	test("the flag shows the writer's kind icon before its name", () => {
		const marks = attach();
		const flagParts = () => {
			const widget = flags.at(-1) as { getDomNode(): { children: { children: FakeNode[] }[] } };
			const body = widget.getDomNode().children[0]?.children ?? [];
			return body.map((part) => [part.className, part.innerHTML ?? part.textContent]);
		};
		marks.setLatest({ hash: "a", writer: AGENT });
		marks.land(editLine(5, "a"));
		const [icon, name] = flagParts();
		expect(icon?.[0]).toBe("presence-flag-icon");
		expect(icon?.[1]).toContain("<svg");
		expect(name).toEqual(["presence-flag-name", "Agent"]);
		marks.setLatest({ hash: "b", writer: ELSEWHERE });
		marks.land(editLine(9, "b"));
		expect(flagParts()[0]?.[1]).not.toBe(icon?.[1]);
		marks.dispose();
	});

	test("a second writer on the same line takes the flag", () => {
		const marks = attach();
		marks.setLatest({ hash: "a", writer: AGENT });
		marks.land(editLine(5, "a"));
		marks.setLatest({ hash: "b", writer: OTHER });
		marks.land(editLine(5, "b"));
		expect(flags).toHaveLength(1);
		expect(bars()).toEqual([
			"presence-bar presence-tone-agent1",
			"presence-bar presence-tone-agent2",
		]);
		marks.dispose();
	});

	test("a whole-file rewrite retires earlier line marks but keeps a newer landing", () => {
		const marks = attach();
		marks.setLatest({ hash: "h1", writer: AGENT });
		marks.land(editLine(5, "h1"));
		marks.land({
			hash: "h2",
			before: TEXT,
			changes: [{ from: 0, to: TEXT.length, insert: TEXT.toUpperCase() }],
		});
		marks.land(editLine(9, "h3"));
		marks.setLatest({ hash: "h2", writer: OTHER });
		expect(chips).toHaveLength(1);
		expect(bars()).toEqual([]);
		expect(flags).toHaveLength(0);
		marks.setLatest({ hash: "h3", writer: AGENT });
		expect(bars()).toEqual(["presence-bar presence-tone-agent1"]);
		marks.dispose();
	});

	test("flags and chips show the label while announcements use the spoken name", () => {
		const titled: PresenceWriter = { ...AGENT, label: "Fix auth", spoken: "Agent Fix auth" };
		const marks = attach();
		marks.setLatest({ hash: "h1", writer: titled });
		marks.land(editLine(4, "h1"));
		const flag = flags.at(-1) as { getDomNode(): { children: { children: FakeNode[] }[] } };
		expect(flag.getDomNode().children[0]?.children[1]?.textContent).toBe("Fix auth");
		expect(announced).toEqual(["Agent Fix auth changed 4-4"]);
		marks.setLatest({ hash: "h2", writer: titled });
		marks.land({
			hash: "h2",
			before: TEXT,
			changes: [{ from: 0, to: TEXT.length, insert: TEXT.toUpperCase() }],
		});
		const chip = chips.at(-1) as { getDomNode(): FakeNode };
		expect(chip.getDomNode().textContent).toBe("Fix auth rewrote this file");
		expect(announced.at(-1)).toBe("Agent Fix auth rewrote this file");
		marks.dispose();
	});

	test("the bar's tooltip is the plain label, since Monaco escapes it", () => {
		const marks = attach();
		marks.setLatest({ hash: "h1", writer: { ...AGENT, label: 'Agent · "<A> & B"' } });
		marks.land(editLine(4, "h1"));
		const [bar] = collections.flatMap((collection) => collection.decorations);
		expect(bar?.options.linesDecorationsTooltip).toBe('Changed by Agent · "<A> & B"');
		marks.dispose();
	});

	test("one write that changed two places announces both", () => {
		const marks = attach();
		marks.setLatest({ hash: "h1", writer: AGENT });
		const at = (line: number) => lineOffset(line);
		marks.land({
			hash: "h1",
			before: TEXT,
			changes: [
				{ from: at(4), to: at(4) + "line 4".length, insert: "four" },
				{ from: at(15), to: at(15) + "line 15".length, insert: "fifteen" },
			],
		});
		expect(announced).toEqual(["Agent changed 4-4, 15-15"]);
		marks.dispose();
	});

	test("a write that changed many separate lines announces how many, not every line", () => {
		const marks = attach();
		marks.setLatest({ hash: "h1", writer: AGENT });
		const lines = [1, 4, 7, 10, 13, 16];
		marks.land({
			hash: "h1",
			before: TEXT,
			changes: lines.map((line) => ({
				from: lineOffset(line),
				to: lineOffset(line) + `line ${line}`.length,
				insert: `LINE ${line}`,
			})),
		});
		expect(announced).toEqual(["Agent changed 6 places"]);
		marks.dispose();
	});

	test("the wash fades in fixed steps, so a redrawn line keeps the current step", () => {
		jest.useFakeTimers();
		try {
			const marks = attach();
			marks.setLatest({ hash: "h1", writer: AGENT });
			marks.land(editLine(4, "h1"));
			const wash = () =>
				collections.flatMap((collection) => collection.decorations)[0]?.options.className;
			expect(wash()).toBe("presence-wash presence-wash-0 presence-tone-agent1");
			jest.advanceTimersByTime(600);
			expect(wash()).toBe("presence-wash presence-wash-1 presence-tone-agent1");
			jest.advanceTimersByTime(1800);
			expect(wash()).toBeUndefined();
			marks.dispose();
		} finally {
			jest.useRealTimers();
		}
	});
});
