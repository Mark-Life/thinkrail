import { expect, test } from "bun:test";
import {
	boolArg,
	languageFromPath,
	numArg,
	resultText,
	strArg,
	strListArg,
} from "@thinkrail/extension-api/web";

interface Input {
	command: string;
	offset?: number;
	background?: boolean;
	urls?: string[];
}

test("resultText joins the text blocks of an AgentToolResult-shaped value", () => {
	expect(
		resultText({
			content: [
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			],
		}),
	).toBe("ab");
});

test("resultText skips non-text content blocks (e.g. images)", () => {
	expect(
		resultText({
			content: [
				{ type: "text", text: "before" },
				{ type: "image", data: "…", mimeType: "image/png" },
				{ type: "text", text: "after" },
			],
		}),
	).toBe("beforeafter");
});

test("resultText returns '' for null / undefined", () => {
	expect(resultText(null)).toBe("");
	expect(resultText(undefined)).toBe("");
});

test("resultText returns the raw string for a string input", () => {
	expect(resultText("hello")).toBe("hello");
});

test("resultText returns pretty JSON for an object with no content array", () => {
	expect(resultText({ foo: 1 })).toBe(JSON.stringify({ foo: 1 }, null, 2));
});

test("resultText pretty-prints when `content` is present but not an array", () => {
	const value = { content: "not-an-array" };
	expect(resultText(value)).toBe(JSON.stringify(value, null, 2));
});

test("strArg returns the string value, or '' when missing / wrong-typed", () => {
	expect(strArg<Input>({ command: "ls" }, "command")).toBe("ls");
	expect(strArg<Input>({}, "command")).toBe("");
	expect(strArg<Input>({ command: 42 }, "command")).toBe("");
	expect(strArg<Input>({ command: null }, "command")).toBe("");
});

test("numArg returns the number value, or null when missing / wrong-typed", () => {
	expect(numArg<Input>({ offset: 10 }, "offset")).toBe(10);
	expect(numArg<Input>({ offset: 0 }, "offset")).toBe(0);
	expect(numArg<Input>({}, "offset")).toBeNull();
	expect(numArg<Input>({ offset: "10" }, "offset")).toBeNull();
});

test("boolArg and strListArg read only values of their type", () => {
	expect(boolArg<Input>({ background: true }, "background")).toBe(true);
	expect(boolArg<Input>({ background: "true" }, "background")).toBeNull();
	expect(strListArg<Input>({ urls: ["a", 1, "b"] }, "urls")).toEqual(["a", "b"]);
	expect(strListArg<Input>({ urls: "a" }, "urls")).toEqual([]);
});

test("a key must be a field of the named input type with the read type", () => {
	// @ts-expect-error: no input type named, so no key is accepted
	strArg({ command: "ls" }, "command");
	// @ts-expect-error: `offset` is a number field
	strArg<Input>({ offset: 1 }, "offset");
	// @ts-expect-error: `cmd` is not a field of the input
	strArg<Input>({ cmd: "ls" }, "cmd");
});

test("languageFromPath maps known extensions and falls back to ''", () => {
	expect(languageFromPath("src/App.tsx")).toBe("tsx");
	expect(languageFromPath("index.ts")).toBe("typescript");
	expect(languageFromPath("script.py")).toBe("python");
	expect(languageFromPath("run.sh")).toBe("bash");
	expect(languageFromPath("data.YAML")).toBe("yaml");
	expect(languageFromPath("notes.unknown")).toBe("");
	expect(languageFromPath("Makefile")).toBe("");
});
