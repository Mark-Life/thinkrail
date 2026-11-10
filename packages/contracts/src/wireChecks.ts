import type { Validator } from "@earendil-works/pi-schema";

const MAX_DESCRIBED_ERRORS = 5;

/** Why `value` fails `validator`: up to five `path message` pairs. `root` names the value itself. */
export function describeFailure<T>(validator: Validator<T>, value: unknown, root: string) {
	return validator
		.errors(value)
		.slice(0, MAX_DESCRIBED_ERRORS)
		.map((error) => `${error.path || root} ${error.message}`)
		.join("; ");
}
