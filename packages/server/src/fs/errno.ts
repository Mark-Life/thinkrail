import { lstatSync, type Stats, statSync } from "node:fs";

export function errnoCode(error: unknown): unknown {
	return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

export function isMissing(error: unknown): boolean {
	const code = errnoCode(error);
	return code === "ENOENT" || code === "ENOTDIR";
}

export function statOrNull(abs: string, follow: boolean): Stats | null {
	try {
		return follow ? statSync(abs) : lstatSync(abs);
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
}
