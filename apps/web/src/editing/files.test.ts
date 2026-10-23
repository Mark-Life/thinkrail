import { expect, test } from "bun:test";
import type { FileTab } from "../store";
import { useAppStore } from "../store";
import { syncFileTabs } from "./files";

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
