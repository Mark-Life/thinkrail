import { compile, map, type Schema, unknown, type Validator } from "@earendil-works/pi-schema";
import { WS_METHOD_SCHEMAS } from "./methods";

/** Any non-null, non-array value, for a reader that checks its fields one by one. */
export const JsonObject = compile(map(unknown()));

const validators = new Map<Schema<unknown>, Validator>();

export function validatorOf(schema: Schema<unknown>): Validator {
	const known = validators.get(schema);
	if (known) return known;
	const validator = compile(schema);
	validators.set(schema, validator);
	return validator;
}

export function resultProblem(
	method: keyof typeof WS_METHOD_SCHEMAS,
	result: unknown,
): string | null {
	const schema: Schema<unknown> = WS_METHOD_SCHEMAS[method].result;
	const validator = validatorOf(schema);
	if (validator.check(result)) return null;
	const [first] = validator.errors(result);
	return `${method} replied with a shape its schema refuses: ${first?.path} ${first?.message}`;
}
