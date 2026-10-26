import { expect, spyOn, test } from "bun:test";
import { CLIENT_ERROR_REPORT_PROTOCOL_VERSION } from "@thinkrail/contracts";
import type { FileTab } from "../store";
import { useAppStore } from "../store";
import * as transport from "../transport";
import { loadBufferRegistry, syncFileTabs } from "./files";

const meta = (hash: string, text: string) => ({ hash, byteLength: text.length, text: true });

function fileTab(id: string, path: string, loadedTick: number): FileTab {
	return {
		kind: "file",
		id,
		workspaceId: "ws",
		name: path,
		path,
		content: "before\n",
		meta: meta("h-before", "before\n"),
		loadedTick,
	};
}

test("a buffer's own disk read refreshes the file tab, unless the tab already holds a newer read", () => {
	useAppStore.setState({
		tabsByWorkspace: { ws: [fileTab("a", "a.ts", 3), fileTab("b", "b.ts", 3)] },
	});
	const file = { content: "changed while offline\n", meta: meta("h-after", "changed\n") };
	syncFileTabs("ws", "a.ts", file, 3);
	const [a, b] = useAppStore.getState().tabsByWorkspace.ws ?? [];
	expect(a).toMatchObject({ content: file.content, meta: file.meta, loadedTick: 3 });
	expect(b).toMatchObject({ content: "before\n", loadedTick: 3 });

	syncFileTabs("ws", "b.ts", file, 2);
	expect(useAppStore.getState().tabsByWorkspace.ws?.[1]).toMatchObject({
		content: "before\n",
		loadedTick: 3,
	});
});

test("a failed registry load is retried by the next caller", async () => {
	let calls = 0;
	const failing = () => {
		calls++;
		return Promise.reject(new Error("chunk failed"));
	};
	await expect(loadBufferRegistry(failing)).rejects.toThrow("chunk failed");
	await expect(loadBufferRegistry(failing)).rejects.toThrow("chunk failed");
	expect(calls).toBe(2);
});

test("callers waiting on one failed registry load send one error report", async () => {
	const methods: string[] = [];
	const spy = spyOn(transport, "getTransport").mockReturnValue({
		request: (method: string) => {
			methods.push(method);
			return Promise.resolve({ ok: true });
		},
	} as unknown as ReturnType<typeof transport.getTransport>);
	useAppStore.setState({ protocolVersion: CLIENT_ERROR_REPORT_PROTOCOL_VERSION });
	methods.length = 0;
	try {
		let calls = 0;
		const failing = () => {
			calls++;
			return Promise.reject(new Error("chunk failed"));
		};
		const results = await Promise.allSettled([
			loadBufferRegistry(failing),
			loadBufferRegistry(failing),
			loadBufferRegistry(failing),
		]);
		expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"]);
		expect(calls).toBe(1);
		expect(methods.filter((method) => method === "client.reportError")).toHaveLength(1);
	} finally {
		spy.mockRestore();
		useAppStore.setState({ protocolVersion: null });
	}
});

test("switching the active tab or workspace flushes autosave; other store changes do not", async () => {
	const { createBufferRegistry } = await import("./registry");
	let flushes = 0;
	await loadBufferRegistry(async () => ({
		createBufferRegistry: (deps) => ({
			...createBufferRegistry({ ...deps, hostKey: () => "http://host" }),
			flushAll: () => {
				flushes += 1;
			},
		}),
	}));
	useAppStore.setState({ activeWorkspaceId: "ws", activeTabByWorkspace: { ws: "a", other: "c" } });
	flushes = 0;
	useAppStore.setState({ activeTabByWorkspace: { ws: "b", other: "c" } });
	expect(flushes).toBe(1);
	useAppStore.setState({ activeTabByWorkspace: { ws: "b", other: "d" } });
	expect(flushes).toBe(1);
	useAppStore.setState({ activeWorkspaceId: "other" });
	expect(flushes).toBe(2);
	useAppStore.setState({ protocolVersion: null });
	expect(flushes).toBe(2);
});
