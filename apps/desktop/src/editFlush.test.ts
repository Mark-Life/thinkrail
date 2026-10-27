import { expect, test } from "bun:test";
import { flushBeforeShutdown, isVetoableEvent } from "./editFlush";

test("the host stops only after the web client wrote its drafts", async () => {
	const steps: string[] = [];
	const stop = flushBeforeShutdown({
		flush: async () => {
			await Promise.resolve();
			steps.push("flush");
		},
		shutdown: async () => {
			steps.push("shutdown");
		},
		timeoutMs: 1000,
		reportError: () => {},
	});
	await stop();
	expect(steps).toEqual(["flush", "shutdown"]);
});

test("a web client that never answers or fails cannot hold the quit", async () => {
	const errors: unknown[] = [];
	let stopped = 0;
	const options = {
		shutdown: async () => {
			stopped += 1;
		},
		timeoutMs: 5,
		reportError: (error: unknown) => errors.push(error),
	};
	await flushBeforeShutdown({ ...options, flush: () => new Promise<void>(() => {}) })();
	await flushBeforeShutdown({
		...options,
		flush: () => Promise.reject(new Error("rpc timeout")),
	})();
	expect(stopped).toBe(2);
	expect(errors).toHaveLength(1);
});

test("only an object with a response slot counts as a vetoable event", () => {
	expect(isVetoableEvent({ response: undefined })).toBe(true);
	expect(isVetoableEvent(null)).toBe(false);
	expect(isVetoableEvent({ data: { id: 1 } })).toBe(false);
});
