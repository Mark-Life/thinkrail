import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { Validator } from "@earendil-works/pi-schema";
import { CodedError } from "@thinkrail/shared/codedError";

export type StateFileObserver = (problem: CodedError) => void;

export interface StateFile {
	/** The parsed JSON; `undefined` when the file is missing, unreadable, or not JSON. */
	value: unknown;
	setAside(reason: string): void;
}

let observer: StateFileObserver | null = null;
const refusedOverwrites = new Set<string>();

export function observeStateFileProblems(next: StateFileObserver | null): void {
	observer = next;
}

export function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function report(code: "STATE_FILE_SET_ASIDE" | "STATE_FILE_UNREADABLE", message: string): void {
	try {
		observer?.(new CodedError(code, message));
	} catch {}
}

function keepCopy(path: string, raw: string, reason: string): void {
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
	const copy = `${path}.corrupt-${hash}`;
	try {
		writeFileSync(copy, raw, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (hasErrorCode(error, "EEXIST")) return;
		refusedOverwrites.add(path);
		report("STATE_FILE_UNREADABLE", `${basename(path)}: ${reason}, and no copy could be kept`);
		return;
	}
	report("STATE_FILE_SET_ASIDE", `${basename(path)}: ${reason}; copy at ${basename(copy)}`);
}

export function readStateFile(path: string): StateFile {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) refusedOverwrites.delete(path);
		else if (!refusedOverwrites.has(path)) {
			refusedOverwrites.add(path);
			report("STATE_FILE_UNREADABLE", `${basename(path)}: could not be read`);
		}
		return { value: undefined, setAside: () => {} };
	}
	refusedOverwrites.delete(path);
	const setAside = (reason: string) => keepCopy(path, raw, reason);
	try {
		return { value: JSON.parse(raw), setAside };
	} catch {
		setAside("not JSON");
		return { value: undefined, setAside };
	}
}

export function parseEntries<T>(
	file: StateFile,
	entries: readonly unknown[],
	validator: Validator<T>,
): T[] {
	const kept: T[] = [];
	const dropped: string[] = [];
	for (const [index, entry] of entries.entries()) {
		if (validator.check(entry)) kept.push(entry);
		else dropped.push(`${index}${validator.errors(entry)[0]?.path ?? ""}`);
	}
	if (dropped.length > 0) file.setAside(`dropped entries ${dropped.join(", ")}`);
	return kept;
}

export function assertOverwriteAllowed(path: string): void {
	if (refusedOverwrites.has(path)) {
		throw new CodedError(
			"STATE_FILE_UNREADABLE",
			`${basename(path)} could not be read, so it was not replaced`,
		);
	}
}
