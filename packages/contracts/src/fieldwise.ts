import type { Validator } from "@earendil-works/pi-schema";
import { JsonObject } from "./schema";

function topField(path: string): string | undefined {
	return path.split("/")[1]?.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** The top-level fields of an object that pass on their own: one bad field costs one field. */
export function keepValidFields<T>(
	value: unknown,
	validator: Validator<T>,
): { fields: T; dropped: string[] } | null {
	if (!JsonObject.check(value)) return null;
	const fields: Record<string, unknown> = Object.fromEntries(
		Object.entries(value).filter(([, field]) => field !== undefined),
	);
	const dropped: string[] = [];
	while (!validator.check(fields)) {
		const field = topField(validator.errors(fields)[0]?.path ?? "");
		if (field === undefined || !Object.hasOwn(fields, field)) return null;
		delete fields[field];
		dropped.push(field);
	}
	return { fields, dropped };
}
