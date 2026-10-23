import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { toEditorText } from "@thinkrail/contracts";
import { classifyBytes, decodeText } from "../fs";

export const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

export interface FileSnapshot {
	bytes: Uint8Array;
	mtimeMs: number;
}

export function readSnapshot(abs: string): FileSnapshot | null {
	try {
		const stat = statSync(abs);
		if (!stat.isFile() || stat.size > SNAPSHOT_MAX_BYTES) return null;
		return { bytes: readFileSync(abs), mtimeMs: stat.mtimeMs };
	} catch {
		return null;
	}
}

export function fileKey(abs: string): string {
	const lexical = resolve(abs);
	try {
		return realpathSync(lexical);
	} catch {
		return lexical;
	}
}

export function editorText(bytes: Uint8Array | null): string | null {
	if (bytes === null || !classifyBytes(bytes).text) return null;
	return toEditorText(decodeText(bytes));
}

export function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
	if (a === null || b === null) return a === b;
	return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b);
}

export function firstChangedLine(before: string, after: string): number | undefined {
	if (before === after) return undefined;
	const old = before.split("\n");
	const next = after.split("\n");
	let index = 0;
	while (index < old.length && index < next.length && old[index] === next[index]) index++;
	return Math.min(index, Math.max(next.length - 1, 0)) + 1;
}
