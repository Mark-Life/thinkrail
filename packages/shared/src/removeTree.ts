import { rmSync } from "node:fs";
import { type ErrnoCode, hasErrno } from "./errnoCode";

const RETRYABLE_CODES: readonly ErrnoCode[] = [
	"EBUSY",
	"EMFILE",
	"ENFILE",
	"ENOTEMPTY",
	"EPERM",
	"EACCES",
];
const DEFAULT_ATTEMPTS = 10;
const DEFAULT_DELAY_MS = 100;

export interface RemoveTreeOptions {
	attempts?: number;
	delayMs?: number;
	remove?: (path: string) => void;
}

function removeOnce(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function removeTree(path: string, options: RemoveTreeOptions = {}): void {
	const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
	const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
	const remove = options.remove ?? removeOnce;
	for (let attempt = 1; ; attempt++) {
		try {
			remove(path);
			return;
		} catch (error) {
			if (attempt >= attempts || !hasErrno(error, ...RETRYABLE_CODES)) throw error;
			sleepSync(attempt * delayMs);
		}
	}
}
