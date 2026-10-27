import { expect, test } from "bun:test";
import { errorText } from "./errorText";
import { RequestError } from "./requestError";

test("a replay refusal shows localized advice instead of the host's message", () => {
	const overflow = new RequestError(
		"REQUEST_REPLAY_OVERFLOW",
		"replay namespace for this client is full",
	);
	expect(errorText(overflow)).toContain("too many unread answers");
	expect(errorText(overflow)).toContain("reload the window");
	expect(errorText(new RequestError("REQUEST_REPLAY_CONFLICT", "id reused"))).toContain(
		"ID was already used",
	);
	expect(errorText(new RequestError("REQUEST_REPLAY_UNRETAINED", "too big"))).toContain(
		"could not keep its answer",
	);
});

test("other failures keep the host's message, a string, or the fallback", () => {
	expect(errorText(new RequestError("NOT_GIT", "not a git repository"))).toBe(
		"not a git repository",
	);
	expect(errorText(new Error("boom"))).toBe("boom");
	expect(errorText("plain")).toBe("plain");
	expect(errorText(undefined)).toBe("The request failed.");
});
