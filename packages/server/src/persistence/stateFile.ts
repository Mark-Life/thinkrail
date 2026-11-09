import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Validator } from "@earendil-works/pi-schema";
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

function report(code: "STATE_FILE_SET_ASIDE" | "STATE_FILE_UNREADABLE", message: string): void {
	try {
		observer?.(new CodedError(code, message));
	} catch {}
}

function removeOldestCopies(path: string): void {
	const dir = dirname(path);
	const prefix = `${basename(path)}.corrupt-`;
	try {
		const copies = readdirSync(dir)
			.filter((name) => name.startsWith(prefix))
			.map((name) => join(dir, name))
			.map((copy) => ({ copy, modified: statSync(copy).mtimeMs }))
			.sort((a, b) => b.modified - a.modified);
		for (const { copy } of copies.slice(MAX_COPIES_PER_FILE)) rmSync(copy, { force: true });
	} catch {}
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

function holdsNonFinite(value: unknown): boolean {
	if (typeof value === "number") return !Number.isFinite(value);
	if (typeof value !== "object" || value === null) return false;
	return Object.values(value).some(holdsNonFinite);
}

function keepValid<K extends number | string, T>(
	file: StateFile,
	entries: Iterable<readonly [K, unknown]>,
	validator: Validator<T>,
): [K, T][] {
	const kept: [K, T][] = [];
	const dropped: string[] = [];
	for (const [key, entry] of entries) {
		if (holdsNonFinite(entry)) dropped.push(`${key} holds a number outside the JSON range`);
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
