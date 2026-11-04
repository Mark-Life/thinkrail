import { expect, test } from "bun:test";
import { parsePickedFolder } from "./folderPicker";

test("returns the picked folder", () => {
	expect(parsePickedFolder('["/Users/me/repo"]')).toBe("/Users/me/repo");
});

test("reads a cancelled panel as no folder", () => {
	expect(parsePickedFolder("")).toBeNull();
	expect(parsePickedFolder("[]")).toBeNull();
});

test("rejects a payload the SDK contract does not allow", () => {
	expect(() => parsePickedFolder("{}")).toThrow(TypeError);
	expect(() => parsePickedFolder("[1]")).toThrow(TypeError);
});
