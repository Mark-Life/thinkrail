import { expect, test } from "bun:test";
import {
	parseWsPush,
	parseWsResult,
	wsChannelOf,
	wsPushValidator,
	wsResultValidator,
} from "./wireChecks";
import { WS_CHANNELS, WS_METHODS } from "./wsProtocol";

test("a reply that drifts from its method's schema names the method and the path", () => {
	expect(parseWsResult("model.list", [])).toEqual({ ok: true, value: [] });
	expect(parseWsResult("workspace.diffStats", { added: "1", removed: 0 })).toEqual({
		ok: false,
		problem: expect.stringMatching(/^workspace\.diffStats replied .*: \/added /),
	});
	expect(parseWsResult("project.close", undefined)).toEqual({
		ok: false,
		problem: expect.stringContaining(": result "),
	});
});

test("a client reads the welcome of any host version against its floor, the host checks the full welcome", () => {
	const older = { protocolVersion: 60, projects: [{ id: "p1" }] };
	const parsed: unknown = parseWsPush(WS_CHANNELS.serverWelcome, older);
	expect(parsed).toEqual({ ok: true, value: older });
	expect(wsPushValidator(WS_CHANNELS.serverWelcome).check(older)).toBe(false);
	expect(parseWsPush(WS_CHANNELS.serverWelcome, { projects: [] }).ok).toBe(false);
});

test("a push that drifts from its channel's schema names the channel and the path", () => {
	const removed = { projectId: "p", id: "w" };
	expect(parseWsPush(WS_CHANNELS.workspaceRemoved, removed)).toEqual({ ok: true, value: removed });
	expect(parseWsPush(WS_CHANNELS.workspaceRemoved, { ...removed, id: 7 })).toEqual({
		ok: false,
		problem: expect.stringMatching(/^workspace\.removed pushed .*: \/id /),
	});
});

test("only a channel this client knows is named, never an inherited key", () => {
	expect(wsChannelOf(WS_CHANNELS.piEvent)).toBe(WS_CHANNELS.piEvent);
	expect(wsChannelOf("from.a.newer.host")).toBeUndefined();
	expect(wsChannelOf("constructor")).toBeUndefined();
});

test("every method and channel schema compiles, because each compiles on first use", () => {
	for (const method of Object.values(WS_METHODS))
		expect(() => wsResultValidator(method)).not.toThrow();
	for (const channel of Object.values(WS_CHANNELS)) {
		expect(() => wsPushValidator(channel)).not.toThrow();
		expect(() => parseWsPush(channel, null)).not.toThrow();
	}
});
