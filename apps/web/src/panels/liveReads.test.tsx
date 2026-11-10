import { afterAll, beforeAll, expect, test } from "bun:test";
import type { WorkspaceId } from "@thinkrail/contracts";
import { testWorkspaceId } from "@thinkrail/contracts/test-ids";
import { parseHTML } from "linkedom";
import { act, type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import { useAppStore } from "../store";
import { useLiveTabContent } from "./useLiveTabContent";
import { useWorkspaceRead } from "./useWorkspaceRead";

const REACT_GLOBALS = ["IS_REACT_ACT_ENVIRONMENT", "window"] as const;
const saved = REACT_GLOBALS.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);

// react-dom only touches these members when a tree renders no host elements.
beforeAll(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	Reflect.set(globalThis, "window", {
		event: undefined,
		HTMLIFrameElement: class {},
		document: { activeElement: null },
	});
});
afterAll(() => {
	for (const [key, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

function headlessContainer() {
	return parseHTML("<!doctype html><html><body></body></html>").document.createElement("div");
}

async function mount(node: ReactNode) {
	const root = createRoot(headlessContainer());
	await act(async () => root.render(node));
	return {
		rerender: (next: ReactNode) => act(async () => root.render(next)),
		unmount: () => act(async () => root.unmount()),
	};
}

function scriptedReads<T>() {
	const pending: Array<{ key: string; settle: (value: T) => Promise<void> }> = [];
	const read = (key: string) =>
		new Promise<T>((resolve) => {
			pending.push({ key, settle: (value) => act(async () => resolve(value)) });
		});
	return { pending, read, keys: () => pending.map((entry) => entry.key) };
}

const tick = (workspaceId: string, paths: string[], truncated = false) =>
	act(async () => {
		useAppStore.getState().noteFsChanged({
			workspaceId: testWorkspaceId(workspaceId),
			paths,
			truncated,
			skillChange: "none",
		});
	});

function WorkspaceRead(props: {
	workspaceId: string;
	read: (id: string) => Promise<string>;
	results: string[];
	switched?: string[];
}) {
	useWorkspaceRead(testWorkspaceId(props.workspaceId), props.read, {
		onResult: (value) => props.results.push(value),
		onSwitch: (id) => props.switched?.push(id),
	});
	return null;
}

test("a slow workspace read is not re-sent per tick, lands, and then reads once more", async () => {
	const host = scriptedReads<string>();
	const results: string[] = [];
	const view = await mount(
		<WorkspaceRead workspaceId="wr-slow" read={host.read} results={results} />,
	);
	expect(host.keys()).toEqual(["wr-slow"]);
	for (const path of ["a.ts", "b.ts", "c.ts"]) await tick("wr-slow", [path]);
	expect(host.pending).toHaveLength(1);

	await host.pending[0]?.settle("first");
	expect(results).toEqual(["first"]);
	expect(host.pending).toHaveLength(2);
	await host.pending[1]?.settle("second");
	expect(results).toEqual(["first", "second"]);
	expect(host.pending).toHaveLength(2);
	await view.unmount();
});

test("a workspace switch drops the old workspace's answer", async () => {
	const host = scriptedReads<string>();
	const results: string[] = [];
	const switched: string[] = [];
	const props = { read: host.read, results, switched };
	const view = await mount(<WorkspaceRead workspaceId="wr-old" {...props} />);
	await view.rerender(<WorkspaceRead workspaceId="wr-new" {...props} />);
	expect(switched).toEqual(["wr-old"]);
	expect(host.keys()).toEqual(["wr-old", "wr-new"]);

	await host.pending[0]?.settle("old answer");
	expect(results).toEqual([]);
	await host.pending[1]?.settle("new answer");
	expect(results).toEqual(["new answer"]);
	await view.unmount();
});

function LiveTab(props: {
	workspaceId: WorkspaceId;
	path: string;
	read: (path: string) => Promise<string>;
	applied: string[];
}) {
	const [loadedTick, setLoadedTick] = useState(0);
	useLiveTabContent(
		{ workspaceId: props.workspaceId, path: props.path, loadedTick },
		{
			read: () => props.read(props.path),
			applyFresh: (fresh, tickNumber) => {
				props.applied.push(fresh);
				setLoadedTick(tickNumber);
			},
			keepCurrent: setLoadedTick,
		},
	);
	return null;
}

test("a slow tab read waits out further ticks, lands, then catches up once", async () => {
	const host = scriptedReads<string>();
	const applied: string[] = [];
	const view = await mount(
		<LiveTab
			workspaceId={testWorkspaceId("lt-slow")}
			path="f.ts"
			read={host.read}
			applied={applied}
		/>,
	);
	expect(host.pending).toHaveLength(0);
	for (let i = 0; i < 3; i += 1) await tick("lt-slow", ["f.ts"]);
	expect(host.keys()).toEqual(["f.ts"]);

	await host.pending[0]?.settle("v1");
	expect(applied).toEqual(["v1"]);
	expect(host.keys()).toEqual(["f.ts", "f.ts"]);
	await host.pending[1]?.settle("v3");
	expect(applied).toEqual(["v1", "v3"]);
	expect(host.pending).toHaveLength(2);
	await view.unmount();
});

test("a tab that moves to another file drops the old file's answer", async () => {
	const host = scriptedReads<string>();
	const applied: string[] = [];
	const props = { workspaceId: testWorkspaceId("lt-switch"), read: host.read, applied };
	const view = await mount(<LiveTab path="a.ts" {...props} />);
	await tick("lt-switch", [], true);
	await view.rerender(<LiveTab path="b.ts" {...props} />);
	expect(host.keys()).toEqual(["a.ts", "b.ts"]);

	await host.pending[0]?.settle("a contents");
	expect(applied).toEqual([]);
	await host.pending[1]?.settle("b contents");
	expect(applied).toEqual(["b contents"]);
	await view.unmount();
});
