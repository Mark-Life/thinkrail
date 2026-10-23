import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { toEditorText } from "@thinkrail/contracts";
import { classifyBytes, decodeText, hashBytes } from "../fs";

const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

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

const hashes = new WeakMap<Uint8Array, string>();

export function versionHash(bytes: Uint8Array): string {
	const known = hashes.get(bytes);
	if (known !== undefined) return known;
	const hash = hashBytes(bytes);
	hashes.set(bytes, hash);
	return hash;
}

export function fileKey(abs: string): string {
	const lexical = resolve(abs);
	try {
		return realpathSync(lexical);
	} catch {
		const parent = dirname(lexical);
		return parent === lexical ? lexical : join(fileKey(parent), basename(lexical));
	}
}

export function editorText(bytes: Uint8Array): string | null {
	if (!classifyBytes(bytes).text) return null;
	return toEditorText(decodeText(bytes));
}

export function firstChangedLine(before: string, after: string): number | undefined {
	if (before === after) return undefined;
	const old = before.split("\n");
	const next = after.split("\n");
	let index = 0;
	while (index < old.length && index < next.length && old[index] === next[index]) index++;
	return Math.min(index, Math.max(next.length - 1, 0)) + 1;
}
