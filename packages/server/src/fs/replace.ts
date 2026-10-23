import { randomBytes } from "node:crypto";
import {
	accessSync,
	chmodSync,
	chownSync,
	closeSync,
	constants,
	fchmodSync,
	openSync,
	renameSync,
	rmSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { errnoCode } from "./errno";

type WriteStrategy = "atomic" | "inPlace";

export interface CurrentFile {
	stat: Stats;
	bytes: Uint8Array;
}

const IN_PLACE_FALLBACK_CODES = new Set(["EACCES", "EPERM", "EBUSY", "EXDEV"]);

export function writeStrategy(
	stat: Pick<Stats, "nlink" | "uid" | "mode">,
	mode: number,
	uid: number | undefined,
): WriteStrategy {
	if (stat.nlink > 1) return "inPlace";
	const foreign = uid !== undefined && stat.uid !== uid;
	return foreign && (stat.mode & 0o777) === mode ? "inPlace" : "atomic";
}

function writeInPlace(target: string, bytes: Uint8Array, mode: number, current: CurrentFile): void {
	try {
		writeFileSync(target, bytes);
		if ((current.stat.mode & 0o777) !== mode) chmodSync(target, mode);
	} catch (error) {
		try {
			writeFileSync(target, current.bytes);
		} catch {
			throw error;
		}
		throw error;
	}
}

function writeAtomic(target: string, bytes: Uint8Array, mode: number, gid: number): void {
	const dir = dirname(target);
	const tmp = join(dir, `.thinkrail-write-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
	try {
		writeFileSync(tmp, bytes, { flag: "wx" });
		if (statSync(tmp).gid !== gid) chownSync(tmp, -1, gid);
		chmodSync(tmp, mode);
		renameSync(tmp, target);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

export function createFile(target: string, bytes: Uint8Array, mode?: number): void {
	const fd = openSync(target, "wx", mode);
	let complete = false;
	try {
		writeFileSync(fd, bytes);
		if (mode !== undefined) fchmodSync(fd, mode);
		complete = true;
	} finally {
		closeSync(fd);
		if (!complete) rmSync(target, { force: true });
	}
}

export function replaceFile(
	target: string,
	bytes: Uint8Array,
	mode: number,
	current: CurrentFile,
): void {
	accessSync(target, constants.W_OK);
	if (writeStrategy(current.stat, mode, process.getuid?.()) === "inPlace") {
		writeInPlace(target, bytes, mode, current);
		return;
	}
	try {
		writeAtomic(target, bytes, mode, current.stat.gid);
	} catch (error) {
		if (!IN_PLACE_FALLBACK_CODES.has(String(errnoCode(error)))) throw error;
		writeInPlace(target, bytes, mode, current);
	}
}
