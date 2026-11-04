import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

export const FOLDER_PICKER_WORKER = "folderPickerWorker.ts";

export function parsePickedFolder(payload: string): string | null {
	if (!payload) return null;
	const paths: unknown = JSON.parse(payload);
	if (!Array.isArray(paths)) throw new TypeError("Invalid folder picker payload");
	const [first] = paths;
	if (first === undefined) return null;
	if (typeof first !== "string") throw new TypeError("Invalid folder picker payload");
	return first || null;
}

export function createFolderPicker(runtimeDir: string) {
	const libraryPath = join(dirname(process.execPath), "libNativeWrapper.dylib");
	return async () => {
		const payload = await new Promise<string>((resolve, reject) => {
			const worker = new Worker(join(runtimeDir, FOLDER_PICKER_WORKER), {
				workerData: { libraryPath },
			});
			worker.once("message", resolve);
			worker.once("error", reject);
			worker.once("exit", (code) => reject(new Error(`folder picker worker exited ${code}`)));
		});
		return parsePickedFolder(payload);
	};
}
