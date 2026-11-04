import { dlopen, FFIType, ptr } from "bun:ffi";
import { homedir } from "node:os";
import { parentPort, workerData } from "node:worker_threads";

const { symbols } = dlopen(workerData.libraryPath as string, {
	openFileDialog: {
		args: [FFIType.cstring, FFIType.cstring, FFIType.int, FFIType.int, FFIType.int],
		returns: FFIType.cstring,
	},
});

const startingFolder = Buffer.from(`${homedir()}\0`);
const allowedFileTypes = Buffer.from("*\0");
const payload = symbols.openFileDialog(ptr(startingFolder), ptr(allowedFileTypes), 0, 1, 0);

parentPort?.postMessage(payload?.toString() ?? "[]");
