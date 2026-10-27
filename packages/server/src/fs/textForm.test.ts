import { expect, test } from "bun:test";
import { applyForm, createdBytes, textForm } from "./textForm";

const BYTES = new TextEncoder();
const TEXT = new TextDecoder("utf-8", { ignoreBOM: true });

function save(disk: string, content: string): string {
	return TEXT.decode(applyForm(content, textForm(BYTES.encode(disk))));
}

test("an LF file stays LF, whatever endings the content carries", () => {
	expect(save("a\nb\n", "a\nb\nc\n")).toBe("a\nb\nc\n");
	expect(save("a\nb\n", "a\r\nb\r\n")).toBe("a\nb\n");
});

test("a CRLF file given LF content is written CRLF", () => {
	expect(save("a\r\nb\r\n", "a\nb\nc\n")).toBe("a\r\nb\r\nc\r\n");
});

test("the disk file's BOM is re-applied, and a U+FEFF that starts the content is kept behind one", () => {
	expect(save("\uFEFFa\n", "b\n")).toBe("\uFEFFb\n");
	expect(save("a\n", "b\n")).toBe("b\n");
	expect(save("\uFEFFa\n", "\uFEFFb\n")).toBe("\uFEFF\uFEFFb\n");
	expect(save("a\n", "\uFEFFb\n")).toBe("\uFEFF\uFEFFb\n");
	expect(TEXT.decode(createdBytes("\uFEFFb\r\n"))).toBe("\uFEFF\uFEFFb\r\n");
	expect(TEXT.decode(createdBytes("b\r\n"))).toBe("b\r\n");
	expect(textForm(BYTES.encode("\uFEFFa\r\n"))).toEqual({ bom: true, eol: "\r\n" });
});

test("the first line break decides a mixed file's ending", () => {
	expect(textForm(BYTES.encode("a\r\nb\nc\n")).eol).toBe("\r\n");
	expect(textForm(BYTES.encode("a\nb\r\nc\r\n")).eol).toBe("\n");
	expect(save("a\nb\r\nc\r\n", "a\nb\r\nc\r\n")).toBe("a\nb\nc\n");
	expect(textForm(BYTES.encode("\na\r\n")).eol).toBe("\n");
	expect(textForm(BYTES.encode("no break")).eol).toBe("\n");
});

test("a lone CR is folded to the file's ending", () => {
	expect(save("a\r\n", "a\rb")).toBe("a\r\nb");
	expect(save("a\n", "a\rb\r")).toBe("a\nb\n");
});

test("the final newline is the content's own", () => {
	expect(save("a\n", "a")).toBe("a");
	expect(save("a", "a\n")).toBe("a\n");
	expect(save("a\r\nb", "a\nb")).toBe("a\r\nb");
});
