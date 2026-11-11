import type { constants } from "node:os";

export type ErrnoCode = keyof typeof constants.errno;

export function errnoCode(cause: unknown): string | undefined {
	if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
	return typeof cause.code === "string" ? cause.code : undefined;
}

export function hasErrno(cause: unknown, ...codes: readonly ErrnoCode[]): boolean {
	const code = errnoCode(cause);
	return code !== undefined && codes.some((known) => known === code);
}
