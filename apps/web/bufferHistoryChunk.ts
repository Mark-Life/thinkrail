import { fileURLToPath } from "node:url";
import { normalizePath, type Plugin } from "vite";

const BUFFER_HISTORY_QUERY = "?buffer-history";

const EDITING_DIR = normalizePath(fileURLToPath(new URL("./src/editing/", import.meta.url)));

export function isBufferImporter(importer: string | undefined, editingDir = EDITING_DIR): boolean {
	return importer !== undefined && normalizePath(importer).startsWith(editingDir);
}

export function bufferHistoryChunk(editingDir = EDITING_DIR): Plugin {
	return {
		name: "thinkrail:buffer-history-chunk",
		apply: "build",
		enforce: "pre",
		resolveId: {
			filter: { id: /^@codemirror\/commands$/ },
			async handler(source, importer, options) {
				if (!isBufferImporter(importer, editingDir)) return null;
				const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
				return resolved && { ...resolved, id: `${resolved.id}${BUFFER_HISTORY_QUERY}` };
			},
		},
	};
}
