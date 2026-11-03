import { expect, test } from "@playwright/test";
import { resultProblem, WS_CHANNELS } from "@thinkrail/contracts";
import { parseFrame, readReply } from "./fixtures/wire";

test("the setup wire reads only the reply it waits for", () => {
	const reply = JSON.stringify({ id: "a", ok: true, result: { ok: true } });
	expect(readReply(reply, "a")).toEqual({ id: "a", ok: true, result: { ok: true } });
	expect(readReply(reply, "b")).toBeNull();
	expect(readReply("not json", "a")).toBeNull();
	expect(readReply(JSON.stringify({ id: "a", ok: "yes" }), "a")).toBeNull();
	expect(readReply(JSON.stringify({ channel: WS_CHANNELS.serverWelcome }), "a")).toBeNull();
});

test("a reply that drifts from its method's schema names the method and the path", () => {
	expect(resultProblem("model.list", [])).toBeNull();
	expect(resultProblem("model.list", {})).toContain("model.list replied with a shape");
	expect(resultProblem("workspace.list", [{ id: 1 }])).toContain("workspace.list");
});

test("a held channel frame is told apart from replies and noise", () => {
	expect(parseFrame(JSON.stringify({ channel: "provider.changed", data: {} }))).toMatchObject({
		channel: "provider.changed",
	});
	expect(parseFrame(JSON.stringify({ id: "a", ok: true }))).toEqual({ id: "a", ok: true });
	expect(parseFrame(JSON.stringify({ hello: 1 }))).toBeNull();
	expect(parseFrame(JSON.stringify(null))).toBeNull();
	expect(parseFrame(Buffer.from("{}"))).toBeNull();
});
