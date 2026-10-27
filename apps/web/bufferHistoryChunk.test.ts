import { expect, test } from "bun:test";
import { isBufferImporter } from "./bufferHistoryChunk";

test("only modules under the editing dir get the buffer copy of @codemirror/commands", () => {
	const dir = "/repo/apps/web/src/editing/";
	expect(isBufferImporter("/repo/apps/web/src/editing/history.ts", dir)).toBe(true);
	expect(
		isBufferImporter("/repo/packages/resource-renderers/src/support/LiveMarkdownEditor.tsx", dir),
	).toBe(false);
	expect(isBufferImporter("/repo/apps/web/src/editingTools.ts", dir)).toBe(false);
	expect(isBufferImporter(undefined, dir)).toBe(false);
});
