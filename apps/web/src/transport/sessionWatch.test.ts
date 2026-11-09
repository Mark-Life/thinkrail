import { expect, test } from "bun:test";
import { useAppStore } from "../store";
import { createSessionWatch, syncSessionWatchWithRuntimes } from "./sessionWatch";

function harness(options: { runtimeIds?: () => readonly string[]; graceMs?: number } = {}) {
	const calls: (readonly [string, string[]] | readonly [string, string[], "replace"])[] = [];
	let supported = true;
	let welcomed = true;
	const watch = createSessionWatch({
		welcomed: () => welcomed,
		supported: () => supported,
		runtimeIds: options.runtimeIds ?? (() => Object.keys(useAppStore.getState().sessions)),
		send: async (method, sessionIds, replace) => {
			calls.push(replace ? [method, sessionIds, "replace"] : [method, sessionIds]);
		},
		graceMs: options.graceMs ?? 0,
	});
	return {
		watch,
		calls,
		setSupported: (value: boolean) => {
			supported = value;
		},
		setWelcomed: (value: boolean) => {
			welcomed = value;
		},
		drain: () => calls.splice(0),
	};
}

test("installing and dropping chat runtimes watches and unwatches their sessions", () => {
	const { watch, drain } = harness();
	const unsubscribe = syncSessionWatchWithRuntimes(watch, useAppStore);
	try {
		const store = useAppStore.getState();
		store.openChatSession("watch-ws", "watch-a", null, "medium");
		store.openChatSession("watch-ws", "watch-b", null, "medium");
		store.openChatSession("watch-other", "watch-c", null, "medium");
		expect(drain()).toEqual([
			["session.watch", ["watch-a"]],
			["session.watch", ["watch-b"]],
			["session.watch", ["watch-c"]],
		]);

		store.deleteChat("watch-ws", "watch-a");
		expect(drain()).toEqual([["session.unwatch", ["watch-a"]]]);

		store.clearWorkspaceTabs("watch-ws");
		expect(drain()).toEqual([["session.unwatch", ["watch-b"]]]);

		store.clearWorkspaceTabs("watch-other");
		expect(drain()).toEqual([["session.unwatch", ["watch-c"]]]);
	} finally {
		unsubscribe();
	}
});

test("closing a chat to history unwatches it, and the reopen read watches it again", async () => {
	const { watch, drain } = harness();
	const unsubscribe = syncSessionWatchWithRuntimes(watch, useAppStore);
	try {
		const store = useAppStore.getState();
		store.openChatSession("close-ws", "close-a", null, "medium");
		drain();

		store.closeChatToHistory("close-a", false, "close-ws");
		expect(drain()).toEqual([["session.unwatch", ["close-a"]]]);

		const release = await watch.lease("close-a");
		expect(drain()).toEqual([["session.watch", ["close-a"]]]);
		store.openChatSession("close-ws", "close-a", null, "medium");
		release();
		await Bun.sleep(5);
		expect(drain()).toEqual([]);
	} finally {
		unsubscribe();
	}
});

test("a welcome replaces the host set, so a runtime dropped while disconnected is unwatched", () => {
	const runtimes = ["a", "b"];
	const { watch, drain, setSupported } = harness({ runtimeIds: () => runtimes });
	watch.sync();
	expect(drain()).toEqual([["session.watch", ["a", "b"]]]);

	watch.restate();
	expect(drain()).toEqual([["session.watch", ["a", "b"], "replace"]]);

	setSupported(false);
	runtimes.pop();
	watch.sync();
	expect(drain()).toEqual([]);

	setSupported(true);
	watch.restate();
	expect(drain()).toEqual([["session.watch", ["a"], "replace"]]);

	runtimes.pop();
	watch.restate();
	expect(drain()).toEqual([["session.watch", [], "replace"]]);
});

test("an older host gets no watch calls, not even on welcome", () => {
	const { watch, drain, setSupported } = harness({ runtimeIds: () => ["a"] });
	setSupported(false);
	watch.sync();
	watch.restate();
	expect(drain()).toEqual([]);
});

test("a read lease watches at once and unwatches after its grace unless a runtime took over", async () => {
	const runtimes: string[] = [];
	const { watch, drain } = harness({ runtimeIds: () => runtimes });

	const discarded = await watch.lease("discarded");
	expect(drain()).toEqual([["session.watch", ["discarded"]]]);
	discarded();
	discarded();
	expect(drain()).toEqual([]);
	await Bun.sleep(5);
	expect(drain()).toEqual([["session.unwatch", ["discarded"]]]);

	const installed = await watch.lease("installed");
	runtimes.push("installed");
	watch.sync();
	installed();
	await Bun.sleep(5);
	expect(drain()).toEqual([["session.watch", ["installed"]]]);
});

test("a lease taken before the welcome waits for the restate, so its watch follows it", async () => {
	const { watch, drain, setWelcomed } = harness({ runtimeIds: () => ["a"] });
	setWelcomed(false);
	let leased = false;
	const leasing = watch.lease("early").then((release) => {
		leased = true;
		return release;
	});
	await Bun.sleep(1);
	expect(leased).toBe(false);
	expect(drain()).toEqual([]);

	setWelcomed(true);
	watch.restate();
	(await leasing)();
	expect(drain()).toEqual([
		["session.watch", ["a"], "replace"],
		["session.watch", ["early"]],
	]);
});

test("a large set is split to the host's per-call limit, and only the first restate chunk replaces", () => {
	const runtimes = Array.from({ length: 1001 }, (_, i) => `s${i}`);
	const { watch, drain } = harness({ runtimeIds: () => runtimes });
	const shape = () => drain().map(([method, ids, replace]) => [method, ids.length, replace]);
	watch.sync();
	expect(shape()).toEqual([
		["session.watch", 1000, undefined],
		["session.watch", 1, undefined],
	]);
	watch.restate();
	expect(shape()).toEqual([
		["session.watch", 1000, "replace"],
		["session.watch", 1, undefined],
	]);
});
