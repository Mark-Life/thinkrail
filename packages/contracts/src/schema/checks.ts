import { compile, map, type Schema, unknown, type Validator } from "@earendil-works/pi-schema";
import { WS_CHANNEL_SCHEMAS } from "./channels";
import { WsEnvelope } from "./envelope";
import { AnyHostWelcome, HostWelcomeVersions, PROTOCOL_VERSION } from "./host";
import { WS_METHOD_SCHEMAS } from "./methods";

const MAX_REPORTED_ERRORS = 5;

/** Any non-null, non-array value, for a reader that checks its fields one by one. */
export const JsonObject = compile(map(unknown()));

function once<T>(make: () => T): () => T {
	let made: T | undefined;
	return () => {
		made ??= make();
		return made;
	};
}

const envelope = once(() => compile(WsEnvelope));
const welcomeVersions = once(() => compile(HostWelcomeVersions));

const validators = new Map<Schema<unknown>, Validator>();
const CHANNEL_SCHEMAS = new Map<string, Schema<unknown>>(Object.entries(WS_CHANNEL_SCHEMAS));

export function validatorOf(schema: Schema<unknown>): Validator {
	const known = validators.get(schema);
	if (known) return known;
	const validator = compile(schema);
	validators.set(schema, validator);
	return validator;
}

function failureOf(schema: Schema<unknown>, value: unknown): string | null {
	const validator = validatorOf(schema);
	if (validator.check(value)) return null;
	return validator
		.errors(value)
		.slice(0, MAX_REPORTED_ERRORS)
		.map((error) => `${error.path} ${error.message}`)
		.join("; ");
}

export function parseEnvelope(raw: string): WsEnvelope | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	return envelope().check(value) ? value : null;
}

export type ProtocolMismatch = "uiOutdated" | "hostOutdated";

export function welcomeFailure(welcome: unknown): string | null {
	return failureOf(AnyHostWelcome, welcome);
}

export function protocolMismatch(welcome: unknown): ProtocolMismatch | null {
	if (!welcomeVersions().check(welcome)) return "uiOutdated";
	if (welcome.protocolVersion === PROTOCOL_VERSION) {
		return welcomeFailure(welcome) ? "uiOutdated" : null;
	}
	return welcome.protocolVersion > PROTOCOL_VERSION ? "uiOutdated" : "hostOutdated";
}

export function pushFailure(channel: string, data: unknown): string | null {
	if (channel === "server.welcome") return null;
	const schema = CHANNEL_SCHEMAS.get(channel);
	return schema ? failureOf(schema, data) : "unknown channel";
}

export function resultFailure(
	method: keyof typeof WS_METHOD_SCHEMAS,
	result: unknown,
): string | null {
	return failureOf(WS_METHOD_SCHEMAS[method].result, result);
}

export function resultProblem(
	method: keyof typeof WS_METHOD_SCHEMAS,
	result: unknown,
): string | null {
	const failure = resultFailure(method, result);
	return failure && `${method} replied with a shape its schema refuses: ${failure}`;
}
