import { expect, test } from "bun:test";
import { readClientFrame } from "./clientFrames";

function read(frame: unknown) {
	return readClientFrame(JSON.stringify(frame));
}

test("a method this host does not know still reads as a request, so the handler can answer it", () => {
	expect(read({ id: "1", method: "from.the.future", params: { a: 1 } })).toEqual({
		kind: "request",
		request: { id: "1", method: "from.the.future", params: { a: 1 } },
	});
});

test("an edited frame session id still reads as a request, so the handler can answer it", () => {
	expect(read({ id: "1", method: "m", sessionId: "edited header" })).toEqual({
		kind: "request",
		request: { id: "1", method: "m", sessionId: "edited header" },
	});
});

test("a receipt wins over a request, and a broken receipt falls through to the request", () => {
	const request = { id: "1", method: "m" };
	expect(read({ ...request, ack: ["a"] })).toEqual({ kind: "ack", ids: ["a"] });
	expect(read({ ...request, resume: ["a"] })).toEqual({ kind: "resume", ids: ["a"] });
	expect(read({ ...request, ack: "a" }).kind).toBe("request");
});

test.each([
	["not JSON", null],
	["a scalar", 1],
	["an array", []],
	["no method", { id: "1" }],
	["a numeric id", { id: 1, method: "m" }],
	["a numeric session id", { id: "1", method: "m", sessionId: 1 }],
	["a receipt with a numeric id", { ack: ["a", 1] }],
])("%s is refused", (name, frame) => {
	const raw = name === "not JSON" ? "{" : JSON.stringify(frame);
	expect(readClientFrame(raw)).toEqual({ kind: "refused" });
});
