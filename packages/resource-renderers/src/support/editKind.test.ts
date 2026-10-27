import { describe, expect, test } from "bun:test";
import { classifyEdit } from "./editKind";

const idle = { composition: "idle", paste: false, typing: true } as const;

describe("classifyEdit", () => {
	test("one rule names typing, deletes, pastes, compositions and the rest", () => {
		expect(classifyEdit([{ from: 1, to: 1, insert: "x" }], idle)).toBe("type");
		expect(classifyEdit([{ from: 1, to: 2, insert: "x" }], idle)).toBe("type");
		expect(classifyEdit([{ from: 1, to: 3, insert: "xy" }], idle)).toBe("other");
		expect(classifyEdit([{ from: 1, to: 1, insert: "\n" }], idle)).toBe("other");
		expect(classifyEdit([{ from: 0, to: 1, insert: "" }], idle)).toBe("delete");
		expect(classifyEdit([{ from: 0, to: 0, insert: "a\nb" }], { ...idle, paste: true })).toBe(
			"paste",
		);
		expect(
			classifyEdit([{ from: 0, to: 0, insert: "か" }], { ...idle, composition: "start" }),
		).toBe("composeStart");
		expect(
			classifyEdit([{ from: 0, to: 0, insert: "か" }], { ...idle, composition: "active" }),
		).toBe("compose");
	});
	test("an edit that is not keyboard input is never typing", () => {
		expect(classifyEdit([{ from: 1, to: 1, insert: "x" }], { ...idle, typing: false })).toBe(
			"other",
		);
	});
});
