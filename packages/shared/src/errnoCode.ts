export function errnoCode(cause: unknown): string | undefined {
	if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
	return typeof cause.code === "string" ? cause.code : undefined;
}
