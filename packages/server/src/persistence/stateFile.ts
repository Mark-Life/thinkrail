import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Validator } from "@earendil-works/pi-schema";
import { keepValidFields } from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { hasErrno } from "@thinkrail/shared/errnoCode";

type StateFileObserver = (problem: CodedError) => void;

export interface StateFile {
	/** The parsed JSON; `undefined` when the file is missing, unreadable, or not JSON. */
	value: unknown;
	/** The file exists, but could not be read or is not JSON. */
	failed: boolean;
	setAside(reason: string): void;
}

const MAX_COPIES_PER_FILE = 10;

let observer: StateFileObserver | null = null;
const refusedOverwrites = new Set<string>();

export function observeStateFileProblems(next: StateFileObserver | null): void {
	observer = next;
}

type StateFileProblemCode =
	| "STATE_FILE_SET_ASIDE"
	| "STATE_FILE_UNREADABLE"
	| "STATE_FILE_PRUNE_FAILED";

function report(code: StateFileProblemCode, message: string): void {
	observer?.(new CodedError(code, message));
}

function modifiedAt(copy: string): number | null {
	try {
		return statSync(copy).mtimeMs;
	} catch (error) {
		if (hasErrno(error, "ENOENT")) return null;
		throw error;
	}
}

function removeOldestCopies(path: string): void {
	const dir = dirname(path);
	const prefix = `${basename(path)}.corrupt-`;
	try {
		const copies = readdirSync(dir)
			.filter((name) => name.startsWith(prefix))
			.map((name) => join(dir, name))
			.flatMap((copy) => {
				const modified = modifiedAt(copy);
				return modified === null ? [] : [{ copy, modified }];
			})
			.sort((a, b) => b.modified - a.modified);
		for (const { copy } of copies.slice(MAX_COPIES_PER_FILE)) rmSync(copy, { force: true });
	} catch {
		report("STATE_FILE_PRUNE_FAILED", `${basename(path)}: old copies could not be removed`);
	}
}

function keepCopy(path: string, raw: string, reason: string): void {
	const hash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
	const copy = `${path}.corrupt-${hash}`;
	try {
		writeFileSync(copy, raw, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if (hasErrno(error, "EEXIST")) return;
		refusedOverwrites.add(path);
		report("STATE_FILE_UNREADABLE", `${basename(path)}: ${reason}, and no copy could be kept`);
		return;
	}
	removeOldestCopies(path);
	report("STATE_FILE_SET_ASIDE", `${basename(path)}: ${reason}; copy at ${basename(copy)}`);
}

export function readStateFile(path: string): StateFile {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		const missing = hasErrno(error, "ENOENT");
		if (missing) refusedOverwrites.delete(path);
		else if (!refusedOverwrites.has(path)) {
			refusedOverwrites.add(path);
			report("STATE_FILE_UNREADABLE", `${basename(path)}: could not be read`);
		}
		return { value: undefined, failed: !missing, setAside: () => {} };
	}
	refusedOverwrites.delete(path);
	const setAside = (reason: string) => keepCopy(path, raw, reason);
	try {
		return { value: JSON.parse(raw), failed: false, setAside };
	} catch {
		setAside("not JSON");
		return { value: undefined, failed: true, setAside };
	}
}

const MAX_ENTRY_DEPTH = 64;

/** Walks without recursion: a hand-edited file may nest deeper than a recursive check can follow. */
function entryProblem(entry: unknown): string | null {
	const pending: [unknown, number][] = [[entry, 0]];
	for (let next = pending.pop(); next; next = pending.pop()) {
		const [value, depth] = next;
		if (typeof value === "number" && !Number.isFinite(value)) {
			return "holds a number outside the JSON range";
		}
		if (typeof value !== "object" || value === null) continue;
		if (depth >= MAX_ENTRY_DEPTH) return "is nested too deep";
		for (const child of Object.values(value)) pending.push([child, depth + 1]);
	}
	return null;
}

function keepValid<K extends number | string, T>(
	file: StateFile,
	entries: Iterable<readonly [K, unknown]>,
	validator: Validator<T>,
): [K, T][] {
	const kept: [K, T][] = [];
	const dropped: string[] = [];
	for (const [key, entry] of entries) {
		const problem = entryProblem(entry);
		if (problem) dropped.push(`${key} ${problem}`);
		else if (validator.check(entry)) kept.push([key, entry]);
		else dropped.push(`${key}${validator.errors(entry)[0]?.path ?? ""}`);
	}
	if (dropped.length > 0) file.setAside(`dropped entries ${dropped.join(", ")}`);
	return kept;
}

export function parseEntries<T>(
	file: StateFile,
	entries: readonly unknown[],
	validator: Validator<T>,
): T[] {
	return keepValid(file, entries.entries(), validator).map(([, entry]) => entry);
}

export function parseEntryRecord<T>(
	file: StateFile,
	entries: Readonly<Record<string, unknown>>,
	validator: Validator<T>,
): Record<string, T> {
	return Object.fromEntries(keepValid(file, Object.entries(entries), validator));
}

/** One bad field costs one field: drops each top-level field the validator refuses. */
export function parseFields<T>(
	file: StateFile,
	record: Readonly<Record<string, unknown>>,
	validator: Validator<T>,
): T | undefined {
	const finite: Record<string, unknown> = {};
	const dropped: string[] = [];
	for (const [field, value] of Object.entries(record)) {
		const problem = entryProblem(value);
		if (problem) dropped.push(`${field} ${problem}`);
		else finite[field] = value;
	}
	const kept = keepValidFields(finite, validator);
	if (!kept) {
		file.setAside("not readable field by field");
		return undefined;
	}
	dropped.push(...kept.dropped);
	if (dropped.length > 0) file.setAside(`dropped fields ${dropped.join(", ")}`);
	return kept.fields;
}

export function isOverwriteRefused(path: string): boolean {
	return refusedOverwrites.has(path);
}

export function assertOverwriteAllowed(path: string): void {
	if (isOverwriteRefused(path)) {
		throw new CodedError(
			"STATE_FILE_UNREADABLE",
			`${basename(path)} could not be read, so it was not replaced`,
		);
	}
}
