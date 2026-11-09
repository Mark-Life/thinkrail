import { expect, test } from "bun:test";
import { useAppStore } from "../store";
import { createSessionWatch } from "./sessionWatch";

function harness(options: { runtimeIds?: () => readonly string[]; graceMs?: number } = {}) {
	const calls: [string, string[]][] = [];
	let supported = true;
	const watch = createSessionWatch({
		supported: () => supported,
		runtimeIds: options.runtimeIds ?? (() => Object.keys(useAppStore.getState().sessions)),
		send: async (method, sessionIds) => {
			calls.push([method, sessionIds]);
		},
		graceMs: options.graceMs ?? 0,
	});
	return {
		watch,
		calls,
		setSupported: (value: boolean) => {
			supported = value;
		},
		drain: () => calls.splice(0),
	};
}

test("installing and dropping chat runtimes watches and unwatches their sessions", () => {
	const { watch, drain } = harness();
	const unsubscribe = useAppStore.subscribe((state, prev) => {
		if (state.sessions !== prev.sessions) watch.sync();
	});
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

test("a welcome restates the whole set as one add-only watch, and an older host gets nothing", () => {
	const runtimes = ["a", "b"];
	const { watch, drain, setSupported } = harness({ runtimeIds: () => runtimes });
	watch.sync();
	expect(drain()).toEqual([["session.watch", ["a", "b"]]]);

	watch.restate();
	expect(drain()).toEqual([["session.watch", ["a", "b"]]]);

	setSupported(false);
	runtimes.pop();
	watch.restate();
	watch.sync();
	expect(drain()).toEqual([]);

	setSupported(true);
	watch.restate();
	expect(drain()).toEqual([["session.watch", ["a"]]]);
});

test("a read lease watches at once and unwatches after its grace unless a runtime took over", async () => {
	const runtimes: string[] = [];
	const { watch, drain } = harness({ runtimeIds: () => runtimes });

	const discarded = watch.lease("discarded");
	expect(drain()).toEqual([["session.watch", ["discarded"]]]);
	discarded();
	discarded();
	expect(drain()).toEqual([]);
	await Bun.sleep(5);
	expect(drain()).toEqual([["session.unwatch", ["discarded"]]]);

	const installed = watch.lease("installed");
	runtimes.push("installed");
	watch.sync();
	installed();
	await Bun.sleep(5);
	expect(drain()).toEqual([["session.watch", ["installed"]]]);
});

test("a large set is split to the host's per-call limit", () => {
	const runtimes = Array.from({ length: 1001 }, (_, i) => `s${i}`);
	const { watch, calls } = harness({ runtimeIds: () => runtimes });
	watch.sync();
	expect(calls.map(([method, ids]) => [method, ids.length])).toEqual([
		["session.watch", 1000],
		["session.watch", 1],
	]);
});
