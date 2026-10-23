import { randomBytes } from "node:crypto";
import {
	chmodSync,
	chownSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { errnoCode, statOrNull } from "./errno";

type WriteStrategy = "atomic" | "inPlace";

const IN_PLACE_FALLBACK_CODES = new Set(["EACCES", "EPERM", "EBUSY", "EXDEV"]);

export function writeStrategy(
	stat: Pick<Stats, "nlink" | "uid">,
	uid: number | undefined,
): WriteStrategy {
	return stat.nlink > 1 || (uid !== undefined && stat.uid !== uid) ? "inPlace" : "atomic";
}

function writeInPlace(target: string, bytes: Uint8Array, mode: number, stat: Stats): void {
	if ((stat.mode & 0o777) !== mode) chmodSync(target, mode);
	const previous = readFileSync(target);
	try {
		writeFileSync(target, bytes);
	} catch (error) {
		try {
			writeFileSync(target, previous);
		} catch {
			throw error;
		}
		throw error;
	}
}

function writeAtomic(target: string, bytes: Uint8Array, mode: number, gid: number | null): void {
	const dir = dirname(target);
	const tmp = join(dir, `.thinkrail-write-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
	try {
		writeFileSync(tmp, bytes, { flag: "wx" });
		if (gid !== null && statSync(tmp).gid !== gid) chownSync(tmp, -1, gid);
		chmodSync(tmp, mode);
		renameSync(tmp, target);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

export function replaceFile(target: string, bytes: Uint8Array, mode: number): void {
	const stat = statOrNull(target, false);
	if (stat === null) {
		mkdirSync(dirname(target), { recursive: true });
		writeAtomic(target, bytes, mode, null);
		return;
	}
	if (writeStrategy(stat, process.getuid?.()) === "inPlace") {
		writeInPlace(target, bytes, mode, stat);
		return;
	}
	try {
		writeAtomic(target, bytes, mode, stat.gid);
	} catch (error) {
		if (!IN_PLACE_FALLBACK_CODES.has(String(errnoCode(error)))) throw error;
		writeInPlace(target, bytes, mode, stat);
	}
}
