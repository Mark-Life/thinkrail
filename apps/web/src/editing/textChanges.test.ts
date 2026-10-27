import { expect, test } from "bun:test";
import { applyChanges, textChanges } from "./textChanges";

function roundTrip(previous: string, next: string) {
	const changes = textChanges(previous, next);
	expect(applyChanges(previous, changes)).toBe(next);
	return changes;
}

test("equal texts need no change", () => {
	expect(textChanges("a\nb\n", "a\nb\n")).toEqual([]);
});

test("a change on one line touches only the characters that differ", () => {
	expect(roundTrip("one\ntwo\nthree\n", "one\ntWo\nthree\n")).toEqual([
		{ from: 5, to: 6, insert: "W" },
	]);
});

test("separate hunks stay separate, so text between them keeps its offsets", () => {
	const previous = "a\nb\nc\nd\ne\n";
	const changes = roundTrip(previous, "A\nb\nc\nd\nE\n");
	expect(changes).toHaveLength(2);
	expect(changes[0]).toEqual({ from: 0, to: 1, insert: "A" });
	expect(changes[1]).toEqual({ from: 8, to: 9, insert: "E" });
});

test("inserted, deleted and appended lines round-trip", () => {
	roundTrip("a\nb\n", "a\nx\nb\n");
	roundTrip("a\nx\nb\n", "a\nb\n");
	roundTrip("a\nb", "a\nb\nc");
	roundTrip("", "first\n");
	roundTrip("gone\n", "");
});

test("a rewrite past the edit cap falls back to one trimmed change", () => {
	const previous = `${Array.from({ length: 3000 }, (_, index) => `old ${index}`).join("\n")}\nend\n`;
	const next = `${Array.from({ length: 3000 }, (_, index) => `new ${index}`).join("\n")}\nend\n`;
	const changes = roundTrip(previous, next);
	expect(changes).toHaveLength(1);
});

test("applyChanges reads every offset against the original text", () => {
	expect(
		applyChanges("abcdef", [
			{ from: 0, to: 1, insert: "X" },
			{ from: 4, to: 6, insert: "" },
		]),
	).toBe("Xbcd");
});

test("a large rewrite that keeps the line count stays per-line and returns quickly", () => {
	const previous = Array.from({ length: 60_000 }, (_, index) => `line ${index} of the file\n`).join(
		"",
	);
	const next = previous
		.split("\n")
		.map((line, index) => (index % 20 === 0 && line !== "" ? `${line} // changed` : line))
		.join("\n");
	const started = performance.now();
	const changes = textChanges(previous, next);
	expect(performance.now() - started).toBeLessThan(150);
	expect(changes).toHaveLength(3000);
	const lineEnd = previous.indexOf("line 20 ") + "line 20 of the file".length;
	expect(changes[1]).toEqual({ from: lineEnd, to: lineEnd, insert: " // changed" });
	expect(applyChanges(previous, changes)).toBe(next);
});

test("a change never starts or ends inside a surrogate pair", () => {
	const splitsPair = (text: string, offset: number) =>
		offset > 0 &&
		offset < text.length &&
		/[\ud800-\udbff]/.test(text.charAt(offset - 1)) &&
		/[\udc00-\udfff]/.test(text.charAt(offset));
	const cases: [string, string][] = [
		["x 😀\n", "x 😃\n"],
		["😀", "🈀"],
		["a😀b\nline2\n", "a😃b\nline2\n"],
		["😀😀", "😀😃😀"],
		["x", "x😀"],
	];
	for (const [previous, next] of cases) {
		for (const change of roundTrip(previous, next)) {
			expect(splitsPair(previous, change.from)).toBe(false);
			expect(splitsPair(previous, change.to)).toBe(false);
			expect(/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(change.insert)).toBe(false);
		}
	}
	expect(textChanges("x 😀\n", "x 😃\n")).toEqual([{ from: 2, to: 4, insert: "😃" }]);
});
