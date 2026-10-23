export {
	canEditFile,
	discardFile,
	isFileDirty,
	saveFile,
	saveFocusedFile,
} from "./files";
export type { FileBufferHandle } from "./registry";
export { useFileBuffer, useFileBufferText } from "./useFileBuffer";
